import { NextResponse } from "next/server";
import { handleApiError } from "@/lib/api";
import { requireModule } from "@/lib/auth/guards";
import { StoredDocument } from "@/models/proveedores";

// Descarga de un archivo cargado por un proveedor: el XML, el PDF o la
// evidencia.
//
// El portal los sirve en su propia ruta `/api/v1/documents/[key]`, que aquí no
// existe: enlazar allí desde el dashboard daría 404 salvo que los dos corran en
// el mismo origen, y no corren. Por eso una ruta propia sobre la misma colección.
//
// La clave NO es la autorización: cada descarga exige sesión con el módulo
// `proveedores`. Sin eso bastaría con tener una clave para leer la factura de
// cualquier empresa.

export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: Promise<{ key: string }> }) {
  try {
    await requireModule("proveedores");
    const { key } = await params;

    const doc = await StoredDocument().findById(key).lean();
    if (!doc) {
      return NextResponse.json(
        { ok: false, error: { code: "NO_ENCONTRADO", message: "Ese archivo no existe." } },
        { status: 404 }
      );
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
