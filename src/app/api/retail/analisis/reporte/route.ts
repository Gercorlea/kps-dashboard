import type { PipelineStage, Types } from "mongoose";
import type { NextRequest } from "next/server";
import { ApiError, handleApiError, ok, parseQuery } from "@/lib/api";
import { requireModule } from "@/lib/auth/guards";
import { connectDB } from "@/lib/db";
import { columnasHistorico, plantillaPorId } from "@/lib/retail/analisis/plantillas";
import { invalidarRetail } from "@/lib/retail/cache";
import {
  fechasDeCarga,
  PRIMERA_ESCRITURA,
  ramasDeUnReporte,
  type FechasDeCarga,
} from "@/lib/retail/importaciones";
import { fechaISO } from "@/lib/retail/normalize";
import { usuariosPorId } from "@/lib/usuarios";
import { borrarReporteSchema, reporteAnalisisQuerySchema } from "@/lib/validation/retail";
import { SalesReport } from "@/models/SalesReport";

// GET /api/retail/analisis/reporte — ficha de UN reporte guardado.
//
// Es lo que se abre al hacer clic en una fila de "Reportes guardados": la lista
// sólo puede decir el archivo, quién lo subió y cuándo, y de ahí salen las dos
// preguntas que siempre siguen —qué trae dentro y quién ha escrito en él—.
//
// Todo en un solo viaje ($facet): el resumen del contenido y las escrituras por
// usuario recorren las mismas filas.
//
// "Las mismas filas" son dos conjuntos que casi siempre coinciden pero no
// tienen por qué: las que el archivo TIENE hoy (`sourceFile`) describen su
// contenido, y las que CREÓ (`firstSourceFile`) son las que lo fechan. Un
// reporte que se solapa con otro se lleva filas ajenas y pierde propias, así
// que el $match las trae todas y cada rama se queda con las suyas.

interface Resumen {
  filas: number;
  desde: Date | null;
  hasta: Date | null;
  articulos: number;
  marcas: string[];
  /** Escritura más antigua que dejó el archivo; ver `fechasDeCarga`. */
  respaldoImportado: Date | null;
  respaldoAutor: Types.ObjectId | null;
  /** Un `s_<campo>` por métrica de la plantilla. */
  [suma: string]: unknown;
}

/**
 * Quién escribió más recientemente sobre las filas que creó este reporte: es
 * quien lo actualizó. Puede ser quien subió OTRO archivo que se solapa con
 * éste y se llevó parte de sus filas — que es exactamente el cambio del que la
 * ficha quiere dar cuenta.
 *
 * Se agrupa por usuario y no por carga porque "una carga" no es algo que las
 * filas puedan contar por sí solas —una sola viaja en lotes de 2000 filas, cada
 * uno con su marca de tiempo—; el máximo por usuario sí identifica al último.
 */
interface UltimoAutor {
  _id: Types.ObjectId | null;
  hasta: Date;
}

/** El $group por `primerArchivo`, que es el que fecha la carga. */
interface Carga extends FechasDeCarga<Types.ObjectId> {
  _id: null;
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
      // Con qué rama del $match entró cada fila: `esSuya` son las que el
      // archivo tiene hoy, `primerArchivo` dice cuál las creó.
      esSuya: { $eq: ["$sourceFile", sourceFile] },
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
      // El contenido: sólo las filas que el archivo tiene HOY, que es lo que
      // enseña la tabla y lo que se llevaría el botón de borrar.
      resumen: [
        { $match: { esSuya: true } },
        // Por importedAt ascendente para que el $first sea la escritura más
        // antigua que dejó el archivo, que es el respaldo de `fechasDeCarga`.
        { $sort: { importedAt: 1 } },
        {
          $group: {
            _id: null,
            filas: { $sum: 1 },
            respaldoImportado: { $min: "$importedAt" },
            respaldoAutor: { $first: "$importedBy" },
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
            respaldoImportado: 1,
            respaldoAutor: 1,
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
      // Las fechas y el último autor: sólo las filas que el archivo CREÓ, las
      // tenga hoy o se las haya quedado una carga posterior.
      ...ramasDeUnReporte(sourceFile),
    };

    const [facetado] = await SalesReport.aggregate<{
      resumen: Resumen[];
      carga: Carga[];
      ultimoAutor: UltimoAutor[];
    }>([
      {
        $match: {
          ...(account ? { account } : {}),
          $or: [{ sourceFile }, { firstSourceFile: sourceFile }],
        },
      },
      // Proyectar antes del $facet: las ramas ordenan en memoria y ninguna
      // necesita el resto de las columnas del reporte.
      { $project: proyeccion },
      { $facet: ramas },
    ]);

    const resumen = facetado?.resumen?.[0];
    if (!resumen) {
      throw new ApiError(404, "NO_ENCONTRADO", "Ese reporte no está en el histórico");
    }
    const fechas = fechasDeCarga(facetado?.carga?.[0], {
      importado: resumen.respaldoImportado,
      autor: resumen.respaldoAutor,
    });
    // Quien escribió más recientemente es quien actualizó el reporte; sólo se
    // informa si hubo actualización, para no atribuirle a nadie un cambio que
    // no ocurrió.
    const ultimoAutor = fechas.actualizado ? facetado?.ultimoAutor?.[0]?._id : null;
    const usuarios = await usuariosPorId([fechas.subidoPor, ultimoAutor]);

    // Sólo el conteo: la ficha muestra cuántas marcas trae el reporte, no
    // cuáles. El $addToSet de arriba sigue siendo la única forma de contarlas
    // sin traer una fila por marca.
    const marcas = (resumen.marcas ?? []).filter((m) => m.trim() !== "");

    return ok({
      sourceFile,
      account: cabeza.account,
      template: cabeza.template,
      plantilla: plantilla?.nombre ?? null,
      filas: resumen.filas,
      articulos: resumen.articulos,
      marcasTotal: marcas.length,
      // Periodo que cubren los datos, no las fechas de carga.
      desde: resumen.desde ? fechaISO(new Date(resumen.desde)) : null,
      hasta: resumen.hasta ? fechaISO(new Date(resumen.hasta)) : null,
      importado: fechas.importado ? new Date(fechas.importado).toISOString() : null,
      actualizado: fechas.actualizado ? new Date(fechas.actualizado).toISOString() : null,
      subidoPor: usuarios.get(String(fechas.subidoPor)) ?? null,
      actualizadoPor: usuarios.get(String(ultimoAutor)) ?? null,
      metricas: metricas.map((m) => ({
        campo: m.campo,
        nombre: m.nombre,
        total: (resumen[`s_${m.campo}`] as number) ?? 0,
      })),
    });
  } catch (e) {
    return handleApiError(e);
  }
}

// DELETE /api/retail/analisis/reporte — saca un reporte del histórico.
//
// Es la salida para el reporte subido por equivocación: el analizador sólo sabe
// guardar, y sin esto la única forma de corregir un archivo mal cargado era
// volver a subir el bueno encima, que arregla las filas repetidas pero deja las
// que el archivo malo tenía de más.
//
// Borra por `sourceFile` dentro del retailer, que es lo que la ficha llama "un
// reporte". Ojo con la consecuencia del upsert por clave natural: si una carga
// posterior reescribió filas de este archivo, esas filas ya son del otro
// reporte y no se tocan; y al revés, las que este reporte le quitó a uno
// anterior sí se van con él. Por eso la interfaz enseña cuántas filas se van
// antes de confirmar.
export async function DELETE(request: NextRequest) {
  try {
    // Mismo permiso que para guardar: quien puede escribir en el histórico de
    // retail puede deshacer lo que escribió. Restringirlo a superadmin dejaría
    // a quien se equivocó esperando a que otro le corrija el error.
    await requireModule("retail");
    const { account, sourceFile } = parseQuery(request.url, borrarReporteSchema);
    await connectDB();

    const { deletedCount } = await SalesReport.deleteMany({ account, sourceFile });
    if (deletedCount === 0) {
      throw new ApiError(404, "NO_ENCONTRADO", "Ese reporte no está en el histórico");
    }
    // Mismo motivo que al guardar: lo que hay agregado en memoria todavía
    // cuenta las filas que se acaban de ir.
    invalidarRetail();

    return ok({ borradas: deletedCount });
  } catch (e) {
    return handleApiError(e);
  }
}
