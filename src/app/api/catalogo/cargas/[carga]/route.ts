import type { NextRequest } from "next/server";
import { ApiError, handleApiError, ok } from "@/lib/api";
import { requireModule } from "@/lib/auth/guards";
import { borrarFilasDeCarga } from "@/lib/catalogo/cargas";
import { connectDB } from "@/lib/db";
import { CatalogLoad } from "@/models/CatalogLoad";

// DELETE /api/catalogo/cargas/[carga] — descarta una carga a medio subir.
//
// Lo llama el cliente cuando un lote falla, para no dejar filas invisibles
// ocupando espacio. Es best-effort: si no llega, la carga se queda en "loading"
// —igual de invisible— y el barrido del siguiente finalizar la limpia.
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ carga: string }> }
) {
  try {
    const usuario = await requireModule("catalogo");
    const { carga } = await params;
    await connectDB();

    // El filtro por `status: "loading"` es la protección importante: sin él,
    // esta ruta podría borrar el catálogo ACTIVO, que es justo lo que el módulo
    // está mostrando. Un superadmin puede descartar la carga de otra persona
    // (para desatascar una subida abandonada), pero tampoco la activa.
    const res = await CatalogLoad.updateOne(
      {
        loadId: carga,
        status: "loading",
        ...(usuario.role === "superadmin" ? {} : { uploadedBy: usuario.id }),
      },
      { $set: { status: "failed" } }
    );
    if (res.matchedCount === 0) {
      throw new ApiError(
        404,
        "CARGA_NO_ENCONTRADA",
        "No hay una carga en curso con ese id que puedas descartar."
      );
    }

    const borradas = await borrarFilasDeCarga(carga);
    return ok({ borradas });
  } catch (e) {
    return handleApiError(e);
  }
}
