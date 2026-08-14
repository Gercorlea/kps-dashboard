import { isValidObjectId } from "mongoose";
import type { NextRequest } from "next/server";
import { ApiError, handleApiError, ok } from "@/lib/api";
import { requireModule, requireSuperadmin } from "@/lib/auth/guards";
import { connectDB } from "@/lib/db";
import { eliminarCarga } from "@/lib/retail/ingest";
import { fechaISO } from "@/lib/retail/normalize";
import { Upload } from "@/models/Upload";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requireModule("retail");
    const { id } = await params;
    if (!isValidObjectId(id)) throw new ApiError(404, "NO_ENCONTRADO", "Carga no encontrada");

    await connectDB();
    const upload = await Upload.findById(id).populate("uploadedBy", "name").lean();
    if (!upload) throw new ApiError(404, "NO_ENCONTRADO", "Carga no encontrada");

    return ok({
      carga: {
        id: String(upload._id),
        filename: upload.filename,
        account: upload.account,
        cutoffDate: fechaISO(new Date(upload.cutoffDate)),
        status: upload.status,
        sizeBytes: upload.sizeBytes,
        detectedSheets: upload.detectedSheets,
        summary: upload.summary ?? {},
        issues: upload.issues ?? [],
        uploadedBy: (upload.uploadedBy as unknown as { name?: string })?.name ?? "—",
        createdAt: new Date(upload.createdAt).toISOString(),
        processedAt: upload.processedAt ? new Date(upload.processedAt).toISOString() : null,
      },
    });
  } catch (e) {
    return handleApiError(e);
  }
}

// Borrar una carga: solo superadmin; filas en cascada (§6.3).
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requireSuperadmin();
    const { id } = await params;
    if (!isValidObjectId(id)) throw new ApiError(404, "NO_ENCONTRADO", "Carga no encontrada");
    await eliminarCarga(id);
    return ok({ eliminada: true });
  } catch (e) {
    return handleApiError(e);
  }
}
