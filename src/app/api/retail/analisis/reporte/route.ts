import type { PipelineStage } from "mongoose";
import type { NextRequest } from "next/server";
import { ApiError, handleApiError, ok, parseQuery } from "@/lib/api";
import { requireModule } from "@/lib/auth/guards";
import { connectDB } from "@/lib/db";
import { columnasHistorico, plantillaPorId } from "@/lib/retail/analisis/plantillas";
import { filasDelArchivo } from "@/lib/retail/importaciones";
import { fechaISO } from "@/lib/retail/normalize";
import { usuariosPorId } from "@/lib/usuarios";
import { borrarReporteSchema, reporteAnalisisQuerySchema } from "@/lib/validation/retail";
import { ReportImport } from "@/models/ReportImport";
import { SalesReport } from "@/models/SalesReport";

// GET /api/retail/analisis/reporte — ficha de UN reporte guardado.
//
// Es lo que se abre al hacer clic en una fila de "Reportes guardados": la lista
// sólo puede decir el archivo, quién lo subió y cuándo, y de ahí salen las dos
// preguntas que siempre siguen —qué trae dentro y quién ha escrito en él—.
//
// Son dos fuentes y cada una contesta lo suyo: el documento del reporte
// (`reportimports`) dice cuándo se cargó y quién, y las filas que CONTIENE
// dicen qué trae. Antes las dos preguntas salían de las filas, y como un
// reporte solapado se quedaba con las del otro hacía falta un $or y un $facet
// de tres ramas para separar "lo que tiene" de "lo que creó". Con la membresía
// acumulada esa distinción desaparece: ningún archivo pierde filas.

interface Resumen {
  filas: number;
  desde: Date | null;
  hasta: Date | null;
  articulos: number;
  marcas: string[];
  /** Filas que no comparte con ningún otro reporte: las que se irían al borrarlo. */
  exclusivas: number;
  /** Un `s_<campo>` por métrica de la plantilla. */
  [suma: string]: unknown;
}

export async function GET(request: NextRequest) {
  try {
    await requireModule("retail");
    const { account, sourceFile } = parseQuery(request.url, reporteAnalisisQuerySchema);
    await connectDB();

    // La cabecera sale del documento del reporte, y con ella el 404: un reporte
    // existe aunque todas sus filas las comparta con otro, y antes ese caso
    // devolvía 404 sobre un archivo que la lista seguía mostrando.
    const cabeza = await ReportImport.findOne({
      sourceFile,
      ...(account ? { account } : {}),
    }).lean();
    if (!cabeza) {
      throw new ApiError(404, "NO_ENCONTRADO", "Ese reporte no está en el histórico");
    }

    // La plantilla dice qué columnas son métricas: sumar "todo lo numérico"
    // metería los códigos de producto en los totales.
    const plantilla = plantillaPorId(cabeza.template);
    const metricas = plantilla
      ? columnasHistorico(plantilla).filter((c) => c.rol === "metrica")
      : [];

    const sumas: Record<string, unknown> = {};
    const devolverSumas: Record<string, unknown> = {};
    for (const m of metricas) {
      sumas[`s_${m.campo}`] = { $sum: { $ifNull: [`$${m.campo}`, 0] } };
      devolverSumas[`s_${m.campo}`] = 1;
    }

    const pipeline: PipelineStage[] = [
      { $match: filasDelArchivo(cabeza.account, sourceFile) },
      {
        $group: {
          _id: null,
          filas: { $sum: 1 },
          desde: { $min: "$date" },
          hasta: { $max: "$date" },
          articulos: { $addToSet: "$itemNbr" },
          marcas: { $addToSet: "$brand" },
          // Cuántas filas tiene este reporte a solas. Es lo que de verdad
          // desaparece al borrarlo, y lo que el diálogo de confirmación tiene
          // que decir: el resto se queda porque otro reporte también las tiene.
          exclusivas: {
            $sum: { $cond: [{ $eq: [{ $size: "$sourceFiles" }, 1] }, 1, 0] },
          },
          ...sumas,
        },
      },
      {
        $project: {
          filas: 1,
          desde: 1,
          hasta: 1,
          exclusivas: 1,
          // El conteo se hace aquí y no en el cliente: son productos
          // distintos, no filas, y el arreglo entero no hace falta.
          articulos: { $size: "$articulos" },
          marcas: 1,
          ...devolverSumas,
        },
      },
    ];

    const [resumen] = await SalesReport.aggregate<Resumen>(pipeline);

    // Quien reimportó el reporte es quien lo actualizó; sólo se informa si hubo
    // actualización, para no atribuirle a nadie un cambio que no ocurrió.
    const usuarios = await usuariosPorId([cabeza.importedBy, cabeza.reimportedBy]);

    // Sólo el conteo: la ficha muestra cuántas marcas trae el reporte, no
    // cuáles. El $addToSet de arriba sigue siendo la única forma de contarlas
    // sin traer una fila por marca.
    const marcas = (resumen?.marcas ?? []).filter((m) => m.trim() !== "");

    return ok({
      sourceFile,
      account: cabeza.account,
      template: cabeza.template,
      plantilla: plantilla?.nombre ?? null,
      // Un reporte sin filas es el que se quedó vacío porque las suyas se
      // borraron desde otro que también las tenía. Se muestra en cero en vez de
      // desaparecer.
      filas: resumen?.filas ?? 0,
      exclusivas: resumen?.exclusivas ?? 0,
      articulos: resumen?.articulos ?? 0,
      marcasTotal: marcas.length,
      // Periodo que cubren los datos, no las fechas de carga.
      desde: resumen?.desde ? fechaISO(new Date(resumen.desde)) : null,
      hasta: resumen?.hasta ? fechaISO(new Date(resumen.hasta)) : null,
      importado: cabeza.importedAt?.toISOString() ?? null,
      actualizado: cabeza.reimportedAt?.toISOString() ?? null,
      subidoPor: usuarios.get(String(cabeza.importedBy)) ?? null,
      actualizadoPor: usuarios.get(String(cabeza.reimportedBy)) ?? null,
      metricas: metricas.map((m) => ({
        campo: m.campo,
        nombre: m.nombre,
        total: (resumen?.[`s_${m.campo}`] as number) ?? 0,
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
// Borrar un reporte NO es borrar sus filas: las que comparte con otro reporte
// siguen haciendo falta y sólo dejan de estar a su nombre. Antes no se podía
// distinguir —la procedencia era un escalar— y este borrado se llevaba por
// delante las filas que el reporte le había quitado a otro anterior.
export async function DELETE(request: NextRequest) {
  try {
    // Mismo permiso que para guardar: quien puede escribir en el histórico de
    // retail puede deshacer lo que escribió. Restringirlo a superadmin dejaría
    // a quien se equivocó esperando a que otro le corrija el error.
    await requireModule("retail");
    const { account, sourceFile } = parseQuery(request.url, borrarReporteSchema);
    await connectDB();

    // 1. Las filas cuyo ÚNICO dueño es este reporte. La igualdad es contra el
    //    arreglo completo (`[sourceFile]`), no contra un elemento: eso es lo
    //    que separa "sólo suya" de "también suya".
    const { deletedCount } = await SalesReport.deleteMany({
      account,
      sourceFiles: [sourceFile],
    });
    // 2. Las compartidas pierden la membresía y se quedan, porque el otro
    //    reporte las sigue mostrando. Va DESPUÉS del borrado a propósito: al
    //    revés habría un instante con `sourceFiles: []` —filas de nadie que las
    //    gráficas de alcance de cuenta seguirían sumando— y haría falta un
    //    barrido por $size, que no usa índice.
    const { modifiedCount } = await SalesReport.updateMany(filasDelArchivo(account, sourceFile), {
      $pull: { sourceFiles: sourceFile },
    });
    // 3. El reporte, como entidad. Es lo que decide el 404: un reporte existe
    //    aunque no tenga ninguna fila propia.
    const { deletedCount: reportes } = await ReportImport.deleteOne({ account, sourceFile });

    if (reportes === 0 && deletedCount === 0 && modifiedCount === 0) {
      throw new ApiError(404, "NO_ENCONTRADO", "Ese reporte no está en el histórico");
    }
    // `borradas` son las filas que desaparecieron de verdad; `conservadas`, las
    // que sobreviven porque otro reporte también las tiene. La suma es lo que
    // la ficha mostraba como "filas".
    return ok({ borradas: deletedCount, conservadas: modifiedCount });
  } catch (e) {
    return handleApiError(e);
  }
}
