import { isValidObjectId } from "mongoose";
import type { NextRequest } from "next/server";
import { ApiError, handleApiError, ok, parseJson } from "@/lib/api";
import { requireModule } from "@/lib/auth/guards";
import { connectDB } from "@/lib/db";
import { procesarUpload } from "@/lib/retail/ingest";
import { clientIp, enforceRateLimit } from "@/lib/rate-limit";
import { processUploadSchema } from "@/lib/validation/retail";
import { Upload } from "@/models/Upload";

// El parseo corre en el servidor: ~37 mil filas y 5+ MB (§7).
export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requireModule("retail");
    await enforceRateLimit("carga-procesar", clientIp(request));
    const { id } = await params;
    if (!isValidObjectId(id)) throw new ApiError(404, "NO_ENCONTRADO", "Carga no encontrada");

    // La fecha de corte derivada del nombre se confirma o corrige en la UI
    // antes de procesar (§7.4): aquí llega ya validada.
    const body = await parseJson(request, processUploadSchema);
    await connectDB();
    const upload = await Upload.findById(id);
    if (!upload) throw new ApiError(404, "NO_ENCONTRADO", "Carga no encontrada");
    upload.fechaCorte = new Date(`${body.fechaCorte}T00:00:00.000Z`);
    await upload.save();

    const resultado = await procesarUpload(id);
    return ok({
      status: resultado.status,
      resumen: resultado.resumen,
      hojasDetectadas: resultado.hojasDetectadas,
      incidencias: resultado.incidencias,
    });
  } catch (e) {
    return handleApiError(e);
  }
}
