import { Types } from "mongoose";
import type { NextRequest } from "next/server";
import { handleApiError, ok, parseJson, parseQuery } from "@/lib/api";
import { requireModule } from "@/lib/auth/guards";
import { connectDB } from "@/lib/db";
import { guardarAnalisisSchema, historicoAnalisisQuerySchema } from "@/lib/validation/retail";
import { SalesReport } from "@/models/SalesReport";

/** "2024-07-06" → medianoche UTC, como el resto de retail (fechaISO). */
function fechaUTC(iso: string): Date {
  const [a, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(a, m - 1, d));
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

    const archivos = await SalesReport.aggregate<{ _id: string; filas: number; importedAt: Date }>([
      { $match: filtro },
      {
        $group: {
          _id: "$sourceFile",
          filas: { $sum: 1 },
          importedAt: { $max: "$importedAt" },
        },
      },
      { $sort: { importedAt: -1 } },
      { $limit: 20 },
    ]);

    return ok({
      total,
      desde: rango?.desde?.toISOString().slice(0, 10) ?? null,
      hasta: rango?.hasta?.toISOString().slice(0, 10) ?? null,
      archivos: archivos.map((a) => ({
        sourceFile: a._id,
        filas: a.filas,
        importedAt: a.importedAt?.toISOString() ?? null,
      })),
    });
  } catch (e) {
    return handleApiError(e);
  }
}
