import { isValidObjectId } from "mongoose";
import type { NextRequest } from "next/server";
import { ApiError, handleApiError, ok } from "@/lib/api";
import { requireModule, requireSuperadmin } from "@/lib/auth/guards";
import { connectDB } from "@/lib/db";
import { getDownloadUrl } from "@/lib/r2";
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
    const upload = await Upload.findById(id).populate("subidoPor", "nombre").lean();
    if (!upload) throw new ApiError(404, "NO_ENCONTRADO", "Carga no encontrada");

    // Descarga del original: presigned GET de vida corta emitido por este
    // endpoint autenticado — nunca una URL pública (§5.7).
    const descargar = request.nextUrl.searchParams.get("descargar") === "1";
    const downloadUrl = descargar ? await getDownloadUrl(upload.r2Key, upload.filename) : null;

    return ok({
      carga: {
        id: String(upload._id),
        filename: upload.filename,
        cuenta: upload.cuenta,
        fechaCorte: fechaISO(new Date(upload.fechaCorte)),
        status: upload.status,
        sizeBytes: upload.sizeBytes,
        hojasDetectadas: upload.hojasDetectadas,
        resumen: upload.resumen ?? {},
        incidencias: upload.incidencias ?? [],
        subidoPor: (upload.subidoPor as unknown as { nombre?: string })?.nombre ?? "—",
        createdAt: new Date(upload.createdAt).toISOString(),
        processedAt: upload.processedAt ? new Date(upload.processedAt).toISOString() : null,
      },
      downloadUrl,
    });
  } catch (e) {
    return handleApiError(e);
  }
}

// Borrar una carga: solo superadmin; filas en cascada + objeto en R2 (§6.3).
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
