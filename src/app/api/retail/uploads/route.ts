import { Types } from "mongoose";
import type { NextRequest } from "next/server";
import { handleApiError, ok, parseJson, parseQuery } from "@/lib/api";
import { requireModule } from "@/lib/auth/guards";
import { connectDB } from "@/lib/db";
import { claveExcelPrivada, getUploadUrl } from "@/lib/r2";
import { clientIp, enforceRateLimit } from "@/lib/rate-limit";
import { derivarFechaCorte, fechaISO } from "@/lib/retail/normalize";
import { createUploadSchema, uploadsQuerySchema } from "@/lib/validation/retail";
import { Upload, type IResumenHoja } from "@/models/Upload";

function filasDe(resumen: Record<string, IResumenHoja> | undefined): number {
  if (!resumen) return 0;
  return Object.values(resumen).reduce((t, r) => t + (r?.insertadas ?? 0), 0);
}

export async function GET(request: NextRequest) {
  try {
    await requireModule("retail");
    const q = parseQuery(request.url, uploadsQuerySchema);
    await connectDB();

    const filtro: Record<string, unknown> = {};
    if (q.cuenta) filtro.cuenta = q.cuenta;
    if (q.status) filtro.status = q.status;
    if (q.buscar) {
      filtro.filename = { $regex: q.buscar.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" };
    }

    const total = await Upload.countDocuments(filtro);
    const cargas = await Upload.find(filtro)
      .sort({ createdAt: -1 })
      .skip((q.page - 1) * q.limit)
      .limit(q.limit)
      .populate("subidoPor", "nombre")
      .lean();

    return ok({
      cargas: cargas.map((u) => ({
        id: String(u._id),
        filename: u.filename,
        cuenta: u.cuenta,
        fechaCorte: fechaISO(new Date(u.fechaCorte)),
        status: u.status,
        filas: filasDe(u.resumen),
        incidencias: u.incidencias?.length ?? 0,
        subidoPor: (u.subidoPor as unknown as { nombre?: string })?.nombre ?? "—",
        createdAt: new Date(u.createdAt).toISOString(),
      })),
      total,
      pagina: q.page,
      paginas: Math.max(1, Math.ceil(total / q.limit)),
    });
  } catch (e) {
    return handleApiError(e);
  }
}

// Crea la carga y devuelve el presigned PUT para subir directo a R2 (§7).
// Los Excel son confidenciales: prefijo private/, nunca URL pública (§5.7).
export async function POST(request: NextRequest) {
  try {
    const session = await requireModule("retail");
    await enforceRateLimit("carga-crear", clientIp(request));
    const body = await parseJson(request, createUploadSchema);

    await connectDB();
    const uploadId = new Types.ObjectId();
    const r2Key = claveExcelPrivada(String(uploadId), body.filename);
    const fechaCorte = derivarFechaCorte(body.filename) ?? new Date();

    await Upload.create({
      _id: uploadId,
      filename: body.filename,
      r2Key,
      sizeBytes: body.sizeBytes,
      cuenta: body.cuenta,
      fechaCorte,
      status: "pendiente",
      subidoPor: session.id,
    });

    const putUrl = await getUploadUrl(r2Key, body.contentType, body.sizeBytes);
    return ok({
      uploadId: String(uploadId),
      putUrl,
      fechaCorteSugerida: fechaISO(fechaCorte),
      fechaDerivadaDelNombre: derivarFechaCorte(body.filename) !== null,
    });
  } catch (e) {
    return handleApiError(e);
  }
}
