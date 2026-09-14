import { Types } from "mongoose";
import type { NextRequest } from "next/server";
import { handleApiError, ok, parseJson } from "@/lib/api";
import { requireModule } from "@/lib/auth/guards";
import { connectDB } from "@/lib/db";
import { crearCargaSchema, MAX_FILAS_LOTE_CATALOGO } from "@/lib/validation/catalogo";
import { CatalogLoad } from "@/models/CatalogLoad";

// POST /api/catalogo/cargas — abre una carga.
//
// Primer paso de la subida. Devuelve el id con el que viajarán los lotes; hasta
// que se finalice, nada de lo que se escriba bajo ese id lo ve nadie y el
// catálogo anterior sigue siendo el activo.
export async function POST(request: NextRequest) {
  try {
    const usuario = await requireModule("catalogo");
    const datos = await parseJson(request, crearCargaSchema);
    await connectDB();

    // El id lo genera el SERVIDOR, al contrario que en el analizador de retail,
    // donde lo pone el cliente. Aquí el id no es sólo una etiqueta: es lo que
    // autoriza a escribir filas en una carga abierta. Con un id del cliente,
    // cualquiera podría inyectar filas en la carga en curso de otra persona.
    const loadId = crypto.randomUUID();

    await CatalogLoad.create({
      loadId,
      status: "loading",
      filename: datos.filename,
      sizeBytes: datos.sizeBytes,
      productSheet: datos.productSheet,
      mappingSheet: datos.mappingSheet,
      declaredProducts: datos.declaredProducts,
      declaredMappings: datos.declaredMappings,
      discardedProducts: datos.discardedProducts,
      discardedMappings: datos.discardedMappings,
      uploadedBy: new Types.ObjectId(usuario.id),
      uploadedAt: new Date(),
    });

    return ok({ loadId, lotes: MAX_FILAS_LOTE_CATALOGO });
  } catch (e) {
    return handleApiError(e);
  }
}
