import { Types } from "mongoose";
import type { NextRequest } from "next/server";
import { handleApiError, ok, parseJson, parseQuery } from "@/lib/api";
import { requireModule } from "@/lib/auth/guards";
import { connectDB } from "@/lib/db";
import { PRIMERA_ESCRITURA, ULTIMA_ACTUALIZACION } from "@/lib/retail/importaciones";
import { usuariosPorId } from "@/lib/usuarios";
import { guardarAnalisisSchema, historicoAnalisisQuerySchema } from "@/lib/validation/retail";
import { SalesReport } from "@/models/SalesReport";

/** "2024-07-06" → medianoche UTC, como el resto de retail (fechaISO). */
function fechaUTC(iso: string): Date {
  const [a, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(a, m - 1, d));
}

/** Una fila por reporte guardado: el $group de abajo, antes de resolver autores. */
interface ArchivoAgrupado {
  _id: string;
  filas: number;
  importado: Date | null;
  /** Null si el reporte no se ha vuelto a subir desde que se importó. */
  actualizado: Date | null;
  subidoPor: Types.ObjectId | null;
}

// POST /api/retail/analisis — guarda un lote de filas en el histórico.
//
// Upsert por la clave natural (account, itemNbr, date): volver a subir el mismo
// reporte actualiza en vez de duplicar, que es lo que mantiene sano un
// histórico al que se le carga el mismo mes dos veces.
export async function POST(request: NextRequest) {
  try {
    const usuario = await requireModule("retail");
    const { template, account, sourceFile, filas } = await parseJson(
      request,
      guardarAnalisisSchema
    );
    await connectDB();

    const importedAt = new Date();
    const importedBy = new Types.ObjectId(usuario.id);
    const ops = filas.map((f) => {
      const { date, ...resto } = f;
      const fecha = fechaUTC(date);
      return {
        updateOne: {
          filter: { account, itemNbr: f.itemNbr, date: fecha },
          update: {
            $set: {
              ...resto,
              date: fecha,
              template,
              account,
              sourceFile,
              importedAt,
              importedBy,
            },
            // La primera escritura no se toca al volver a subir el reporte: es
            // lo que separa "importado el" de "última actualización" en la
            // ficha del retailer. Una fila con importedAt > firstImportedAt es,
            // exactamente, una fila que reescribió una carga posterior.
            $setOnInsert: { firstImportedAt: importedAt, firstImportedBy: importedBy },
          },
          upsert: true,
        },
      };
    });

    const res = await SalesReport.bulkWrite(ops, { ordered: false });

    return ok({
      recibidas: filas.length,
      insertadas: res.upsertedCount,
      actualizadas: res.modifiedCount,
    });
  } catch (e) {
    return handleApiError(e);
  }
}

// GET /api/retail/analisis — resumen del histórico, para saber qué hay guardado.
export async function GET(request: NextRequest) {
  try {
    await requireModule("retail");
    const { account } = parseQuery(request.url, historicoAnalisisQuerySchema);
    await connectDB();

    const filtro = account ? { account } : {};
    const total = await SalesReport.countDocuments(filtro);
    if (total === 0) return ok({ total: 0, desde: null, hasta: null, archivos: [] });

    const [rango] = await SalesReport.aggregate<{ desde: Date; hasta: Date }>([
      { $match: filtro },
      { $group: { _id: null, desde: { $min: "$date" }, hasta: { $max: "$date" } } },
    ]);

    const archivos = await SalesReport.aggregate<ArchivoAgrupado>([
      { $match: filtro },
      // Proyectar antes de ordenar: el $sort de abajo es en memoria y no tiene
      // por qué arrastrar las métricas de cada fila.
      {
        $project: {
          sourceFile: 1,
          importedAt: 1,
          ...PRIMERA_ESCRITURA,
        },
      },
      // Ordenar por la primera escritura es lo que le da sentido al $first de
      // `subidoPor`: la fila más antigua del archivo es la de la carga original.
      { $sort: { primerImport: 1 } },
      {
        $group: {
          _id: "$sourceFile",
          filas: { $sum: 1 },
          importado: { $min: "$primerImport" },
          actualizado: ULTIMA_ACTUALIZACION,
          subidoPor: { $first: "$primerAutor" },
          // Sólo para ordenar la lista: el reporte tocado más recientemente va
          // primero, igual que antes de que existiera la columna de importado.
          ultimaEscritura: { $max: "$importedAt" },
        },
      },
      { $sort: { ultimaEscritura: -1 } },
      { $limit: 20 },
    ]);

    const autores = await usuariosPorId(archivos.map((a) => a.subidoPor));

    return ok({
      total,
      desde: rango?.desde?.toISOString().slice(0, 10) ?? null,
      hasta: rango?.hasta?.toISOString().slice(0, 10) ?? null,
      archivos: archivos.map((a) => ({
        sourceFile: a._id,
        filas: a.filas,
        importado: a.importado?.toISOString() ?? null,
        actualizado: a.actualizado?.toISOString() ?? null,
        subidoPor: autores.get(String(a.subidoPor)) ?? null,
      })),
    });
  } catch (e) {
    return handleApiError(e);
  }
}
