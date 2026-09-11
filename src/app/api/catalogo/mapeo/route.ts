import { handleApiError, ok } from "@/lib/api";
import { requireModule } from "@/lib/auth/guards";
import { cargaActiva } from "@/lib/catalogo/cargas";
import { CAMPOS_MAPEO } from "@/lib/catalogo/tipos";
import { connectDB } from "@/lib/db";
import { CatalogProduct } from "@/models/CatalogProduct";
import { ProductMapping } from "@/models/ProductMapping";

// GET /api/catalogo/mapeo — TODAS las filas de mapeo de la carga activa.
//
// Se trae completa por el mismo motivo que la de productos: el buscador filtra
// en el navegador en cada tecla. Ver la nota larga en ../productos/route.ts.
export async function GET() {
  try {
    await requireModule("catalogo");
    await connectDB();

    const carga = await cargaActiva();
    if (!carga) {
      return ok({ carga: null, campos: CAMPOS_MAPEO, filas: [], total: 0 });
    }

    const loadId = carga.loadId;

    const [docs, items] = await Promise.all([
      ProductMapping.find({ loadId })
        // Usa el índice (loadId, channel, sku) y agrupa visualmente por cadena,
        // que es como se lee esta tabla.
        .sort({ channel: 1, sku: 1 })
        .select({
          _id: 0,
          sku: 1,
          channel: 1,
          channelName: 1,
          knownRetailer: 1,
          customerCode: 1,
          description: 1,
        })
        .lean(),
      // Una sola consulta para marcar los huérfanos de TODA la tabla. Resolver
      // fila a fila serían cientos de viajes para un dato que es un conjunto.
      CatalogProduct.distinct("item", { loadId }),
    ]);

    const enCatalogo = new Set(items as string[]);

    const filas = docs.map((d) =>
      CAMPOS_MAPEO.map((c) => (c === "enCatalogo" ? enCatalogo.has(d.sku) : (d[c] ?? null)))
    );

    return ok({
      carga: {
        loadId,
        filename: carga.filename,
        finalizadaEl: carga.finalizedAt?.toISOString() ?? null,
      },
      campos: CAMPOS_MAPEO,
      filas,
      total: filas.length,
    });
  } catch (e) {
    return handleApiError(e);
  }
}
