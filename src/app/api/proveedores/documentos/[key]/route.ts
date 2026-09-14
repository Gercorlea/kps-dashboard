import { NextResponse } from "next/server";
import { ApiError, handleApiError } from "@/lib/api";
import { requireUser } from "@/lib/auth/guards";
import { canAccess } from "@/lib/rbac";
import { Invoice, StoredDocument } from "@/models/proveedores";

// Descarga de un archivo cargado por un proveedor: el XML, el PDF o la
// evidencia.
//
// El portal los sirve en su propia ruta `/api/v1/documents/[key]`, que aquí no
// existe: enlazar allí desde el dashboard daría 404 salvo que los dos corran en
// el mismo origen, y no corren. Por eso una ruta propia sobre la misma colección.
//
// La clave NO es la autorización: cada descarga exige sesión con el módulo
// de proveedores o de peticiones. Los revisores solo acceden a documentos
// vinculados a una factura; la clave por sí sola nunca autoriza la descarga.

export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: Promise<{ key: string }> }) {
  try {
    const user = await requireUser();
    const puedeVerProveedor = canAccess(user, "proveedores-alta");
    if (!puedeVerProveedor && !canAccess(user, "peticiones")) {
      throw new ApiError(403, "SIN_PERMISO", "No tienes acceso a estos documentos.");
    }
    const { key } = await params;

    const doc = await StoredDocument().findById(key).lean();
    if (!doc) {
      return NextResponse.json(
        { ok: false, error: { code: "NO_ENCONTRADO", message: "Ese archivo no existe." } },
        { status: 404 }
      );
    }

    if (!puedeVerProveedor) {
      const vinculada = await Invoice().exists({
        $or: [
          { xmlFileKey: key },
          { pdfFileKey: key },
          { "evidence.fileKey": key },
          { transferReceiptFileKey: key },
          { complementXmlFileKey: key },
          { complementPdfFileKey: key },
        ],
      });
      if (!vinculada) throw new ApiError(403, "SIN_PERMISO", "El archivo no pertenece a una petición.");
    }

    // `doc.bytes` llega como Binary de BSON; `.buffer` da los bytes crudos.
    const binario = doc.bytes as unknown as { buffer?: Uint8Array };
    const bytes = binario?.buffer ?? (doc.bytes as unknown as Uint8Array);

    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        "Content-Type": doc.contentType || "application/octet-stream",
        // `inline` para poder mirar el PDF sin bajarlo; el nombre se conserva.
        "Content-Disposition": `inline; filename="${(doc.filename ?? key).replace(/"/g, "")}"`,
        // Privado y sin caché compartida: lo sirve una ruta autenticada.
        "Cache-Control": "private, no-store",
      },
    });
  } catch (e) {
    return handleApiError(e);
  }
}
