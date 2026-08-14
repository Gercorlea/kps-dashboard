import { Types } from "mongoose";
import type { NextRequest } from "next/server";
import { handleApiError, ok, parseJson, parseQuery } from "@/lib/api";
import { requireModule } from "@/lib/auth/guards";
import { connectDB } from "@/lib/db";
import { clientIp, enforceRateLimit } from "@/lib/rate-limit";
import { derivarFechaCorte, fechaISO } from "@/lib/retail/normalize";
import { createUploadSchema, uploadsQuerySchema } from "@/lib/validation/retail";
import { Upload, type IResumenHoja } from "@/models/Upload";

function filasDe(summary: Record<string, IResumenHoja> | undefined): number {
  if (!summary) return 0;
  return Object.values(summary).reduce((t, r) => t + (r?.inserted ?? 0), 0);
}

export async function GET(request: NextRequest) {
  try {
    await requireModule("retail");
    const q = parseQuery(request.url, uploadsQuerySchema);
    await connectDB();

    const filtro: Record<string, unknown> = {};
    if (q.account) filtro.account = q.account;
    if (q.status) filtro.status = q.status;
    if (q.buscar) {
      filtro.filename = { $regex: q.buscar.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" };
    }

    const total = await Upload.countDocuments(filtro);
    const cargas = await Upload.find(filtro)
      .sort({ createdAt: -1 })
      .skip((q.page - 1) * q.limit)
      .limit(q.limit)
      .populate("uploadedBy", "name")
      .lean();

    return ok({
      cargas: cargas.map((u) => ({
        id: String(u._id),
        filename: u.filename,
        account: u.account,
        cutoffDate: fechaISO(new Date(u.cutoffDate)),
        status: u.status,
        filas: filasDe(u.summary),
        issues: u.issues?.length ?? 0,
        uploadedBy: (u.uploadedBy as unknown as { name?: string })?.name ?? "—",
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

// Registra la carga y devuelve la fecha de corte sugerida. El archivo NO
// viaja aquí: se envía al procesar y no se almacena en ninguna parte (§7).
// Los Excel son confidenciales: prefijo private/, nunca URL pública (§5.7).
export async function POST(request: NextRequest) {
  try {
    const session = await requireModule("retail");
    await enforceRateLimit("carga-crear", clientIp(request));

    const body = await parseJson(request, createUploadSchema);

    await connectDB();
    const uploadId = new Types.ObjectId();
    const cutoffDate = derivarFechaCorte(body.filename) ?? new Date();

    await Upload.create({
      _id: uploadId,
      filename: body.filename,
      sizeBytes: body.sizeBytes,
      account: body.account,
      cutoffDate,
      status: "pending",
      uploadedBy: session.id,
    });

    return ok({
      uploadId: String(uploadId),
      fechaCorteSugerida: fechaISO(cutoffDate),
      fechaDerivadaDelNombre: derivarFechaCorte(body.filename) !== null,
    });
  } catch (e) {
    return handleApiError(e);
  }
}
