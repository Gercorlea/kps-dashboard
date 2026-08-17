import type { PipelineStage, Types } from "mongoose";
import type { NextRequest } from "next/server";
import { ApiError, handleApiError, ok, parseQuery } from "@/lib/api";
import { requireModule } from "@/lib/auth/guards";
import { connectDB } from "@/lib/db";
import { columnasHistorico, plantillaPorId } from "@/lib/retail/analisis/plantillas";
import { PRIMERA_ESCRITURA, ULTIMA_ACTUALIZACION } from "@/lib/retail/importaciones";
import { fechaISO } from "@/lib/retail/normalize";
import { usuariosPorId } from "@/lib/usuarios";
import { reporteAnalisisQuerySchema } from "@/lib/validation/retail";
import { SalesReport } from "@/models/SalesReport";

// GET /api/retail/analisis/reporte — ficha de UN reporte guardado.
//
// Es lo que se abre al hacer clic en una fila de "Reportes guardados": la lista
// sólo puede decir el archivo, quién lo subió y cuándo, y de ahí salen las dos
// preguntas que siempre siguen —qué trae dentro y quién ha escrito en él—.
//
// Todo en un solo viaje ($facet): el resumen del contenido y las escrituras por
// usuario recorren las mismas filas.

/** Marcas que se mandan para la ficha; se informa además cuántas hay en total. */
const MAX_MARCAS = 12;

interface Resumen {
  filas: number;
  importado: Date | null;
  /** Null si el reporte no se ha vuelto a subir desde que se importó. */
  actualizado: Date | null;
  subidoPor: Types.ObjectId | null;
  desde: Date | null;
  hasta: Date | null;
  articulos: number;
  marcas: string[];
  /** Un `s_<campo>` por métrica de la plantilla. */
  [suma: string]: unknown;
}

/**
 * Quién escribió las filas que hay hoy en el reporte.
 *
 * Se agrupa por usuario y no por carga: una sola carga viaja en lotes de 2000
 * filas y cada lote trae su propia marca de tiempo, así que "una carga" no es
 * algo que las filas puedan contar por sí solas. Por usuario sí, y con eso se
 * responde lo que se pregunta al abrir la ficha.
 */
interface Autor {
  _id: Types.ObjectId | null;
  filas: number;
  desde: Date;
  hasta: Date;
}

export async function GET(request: NextRequest) {
  try {
    await requireModule("retail");
    const { account, sourceFile } = parseQuery(request.url, reporteAnalisisQuerySchema);
    await connectDB();

    const filtro = { sourceFile, ...(account ? { account } : {}) };

    // La plantilla dice qué columnas son métricas: sumar "todo lo numérico"
    // metería los códigos de artículo en los totales.
    const cabeza = await SalesReport.findOne(filtro)
      .select({ template: 1, account: 1 })
      .lean();
    if (!cabeza) {
      throw new ApiError(404, "NO_ENCONTRADO", "Ese reporte no está en el histórico");
    }
    const plantilla = plantillaPorId(cabeza.template);
    const metricas = plantilla
      ? columnasHistorico(plantilla).filter((c) => c.rol === "metrica")
      : [];

    const proyeccion: Record<string, unknown> = {
      date: 1,
      itemNbr: 1,
      brand: 1,
      importedAt: 1,
      importedBy: 1,
      ...PRIMERA_ESCRITURA,
    };
    const sumas: Record<string, unknown> = {};
    const devolverSumas: Record<string, unknown> = {};
    for (const m of metricas) {
      proyeccion[m.campo] = 1;
      sumas[`s_${m.campo}`] = { $sum: { $ifNull: [`$${m.campo}`, 0] } };
      devolverSumas[`s_${m.campo}`] = 1;
    }

    const ramas: Record<string, PipelineStage.FacetPipelineStage[]> = {
      resumen: [
        // Ordenar por la primera escritura es lo que le da sentido al $first:
        // la fila más antigua del reporte es la de la carga original.
        { $sort: { primerImport: 1 } },
        {
          $group: {
            _id: null,
            filas: { $sum: 1 },
            importado: { $min: "$primerImport" },
            actualizado: ULTIMA_ACTUALIZACION,
            subidoPor: { $first: "$primerAutor" },
            desde: { $min: "$date" },
            hasta: { $max: "$date" },
            articulos: { $addToSet: "$itemNbr" },
            marcas: { $addToSet: "$brand" },
            ...sumas,
          },
        },
        {
          $project: {
            filas: 1,
            importado: 1,
            actualizado: 1,
            subidoPor: 1,
            desde: 1,
            hasta: 1,
            // El conteo se hace aquí y no en el cliente: son artículos
            // distintos, no filas, y el arreglo entero no hace falta.
            articulos: { $size: "$articulos" },
            marcas: 1,
            ...devolverSumas,
          },
        },
      ],
      autores: [
        {
          $group: {
            _id: "$importedBy",
            filas: { $sum: 1 },
            desde: { $min: "$importedAt" },
            hasta: { $max: "$importedAt" },
          },
        },
        { $sort: { hasta: -1 } },
      ],
    };

    const [facetado] = await SalesReport.aggregate<{ resumen: Resumen[]; autores: Autor[] }>([
      { $match: filtro },
      // Proyectar antes del $facet: las dos ramas ordenan en memoria y ninguna
      // necesita el resto de las columnas del reporte.
      { $project: proyeccion },
      { $facet: ramas },
    ]);

    const resumen = facetado?.resumen?.[0];
    if (!resumen) {
      throw new ApiError(404, "NO_ENCONTRADO", "Ese reporte no está en el histórico");
    }
    const autores = facetado?.autores ?? [];

    // Quien escribió más recientemente es quien actualizó el reporte; sólo se
    // informa si hubo actualización, para no atribuirle a nadie un cambio que
    // no ocurrió.
    const ultimoAutor = resumen.actualizado ? autores[0]?._id : null;
    const usuarios = await usuariosPorId([
      resumen.subidoPor,
      ultimoAutor,
      ...autores.map((a) => a._id),
    ]);

    const marcas = (resumen.marcas ?? []).filter((m) => m.trim() !== "").sort();

    return ok({
      sourceFile,
      account: cabeza.account,
      template: cabeza.template,
      plantilla: plantilla?.nombre ?? null,
      filas: resumen.filas,
      articulos: resumen.articulos,
      marcas: marcas.slice(0, MAX_MARCAS),
      marcasTotal: marcas.length,
      // Periodo que cubren los datos, no las fechas de carga.
      desde: resumen.desde ? fechaISO(new Date(resumen.desde)) : null,
      hasta: resumen.hasta ? fechaISO(new Date(resumen.hasta)) : null,
      importado: resumen.importado ? new Date(resumen.importado).toISOString() : null,
      actualizado: resumen.actualizado ? new Date(resumen.actualizado).toISOString() : null,
      subidoPor: usuarios.get(String(resumen.subidoPor)) ?? null,
      actualizadoPor: usuarios.get(String(ultimoAutor)) ?? null,
      metricas: metricas.map((m) => ({
        campo: m.campo,
        nombre: m.nombre,
        total: (resumen[`s_${m.campo}`] as number) ?? 0,
      })),
      autores: autores.map((a) => ({
        usuario: usuarios.get(String(a._id)) ?? null,
        filas: a.filas,
        desde: new Date(a.desde).toISOString(),
        hasta: new Date(a.hasta).toISOString(),
      })),
    });
  } catch (e) {
    return handleApiError(e);
  }
}
