import { isValidObjectId } from "mongoose";
import type { NextRequest } from "next/server";
import { ApiError, handleApiError, ok } from "@/lib/api";
import { requireModule } from "@/lib/auth/guards";
import { connectDB } from "@/lib/db";
import { procesarUpload } from "@/lib/retail/ingest";
import { clientIp, enforceRateLimit } from "@/lib/rate-limit";
import { processUploadSchema } from "@/lib/validation/retail";
import { MAX_XLSX_BYTES } from "@/lib/validation/retail";
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

    // El Excel viaja en esta petición y se parsea en memoria: no se almacena
    // en ningún lado. La fecha de corte derivada del nombre se confirma o
    // corrige en la UI antes de procesar (§7.4).
    const form = await request.formData();
    const archivo = form.get("archivo");
    if (!(archivo instanceof File)) {
      throw new ApiError(422, "VALIDACION", "Falta el archivo .xlsx");
    }
    if (archivo.size > MAX_XLSX_BYTES) {
      throw new ApiError(413, "VALIDACION", "El archivo supera el máximo permitido");
    }
    const body = processUploadSchema.parse({ cutoffDate: form.get("cutoffDate") });
    const buffer = Buffer.from(await archivo.arrayBuffer());

    await connectDB();
    const upload = await Upload.findById(id);
    if (!upload) throw new ApiError(404, "NO_ENCONTRADO", "Carga no encontrada");
    upload.cutoffDate = new Date(`${body.cutoffDate}T00:00:00.000Z`);
    await upload.save();

    const result = await procesarUpload(id, buffer);
    return ok({
      status: result.status,
      summary: result.summary,
      detectedSheets: result.detectedSheets,
      issues: result.issues,
    });
  } catch (e) {
    return handleApiError(e);
  }
}
