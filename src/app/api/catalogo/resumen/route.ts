import { handleApiError, ok } from "@/lib/api";
import { requireModule } from "@/lib/auth/guards";
import { cargaActiva } from "@/lib/catalogo/cargas";
import type { ResumenCatalogo } from "@/lib/catalogo/tipos";
import { connectDB } from "@/lib/db";
import { usuariosPorId } from "@/lib/usuarios";
import { CatalogProduct } from "@/models/CatalogProduct";
import { ProductMapping } from "@/models/ProductMapping";

// GET /api/catalogo/resumen — la cabecera del módulo.
//
// Un solo viaje al montar: qué archivo está activo, quién lo subió y con qué
// avisos, más los productos que se quedaron sin mapeo.
//
// Las OPCIONES DE LOS FILTROS no salen de aquí. Se calculan en el navegador
// (lib/catalogo/facetas.ts) porque su conteo depende de los otros filtros
// activos, y eso sólo lo sabe el cliente: contarlas en el servidor daba un
// número fijo que seguía enseñando el total de la carga aunque hubiera un
// filtro puesto. El navegador ya tiene todas las filas —la tabla se trae
// completa—, así que no hay nada que pedir.
export async function GET() {
  try {
    await requireModule("catalogo");
    await connectDB();

    const carga = await cargaActiva();
    if (!carga) {
      // Nunca se ha subido nada. Se devuelve la envoltura vacía en vez de un
      // error para que la UI pinte su estado vacío con la zona de carga.
      const vacio: ResumenCatalogo = { carga: null, productosSinMapeo: 0 };
      return ok(vacio);
    }

    const loadId = carga.loadId;

    const [items, skus, autores] = await Promise.all([
      CatalogProduct.distinct("item", { loadId }),
      ProductMapping.distinct("sku", { loadId }),
      usuariosPorId([carga.uploadedBy]),
    ]);

    const conMapeo = new Set(skus as string[]);
    const productosSinMapeo = (items as string[]).filter((i) => !conMapeo.has(i)).length;

    const resumen: ResumenCatalogo = {
      carga: {
        loadId,
        filename: carga.filename,
        productos: carga.productCount,
        mapeos: carga.mappingCount,
        descartados: {
          productos: carga.discardedProducts,
          mapeos: carga.discardedMappings,
        },
        huerfanos: carga.orphanMappings,
        finalizadaEl: carga.finalizedAt?.toISOString() ?? null,
        subidaPor: autores.get(String(carga.uploadedBy)) ?? null,
        incidencias: carga.issues,
      },
      productosSinMapeo,
    };

    return ok(resumen);
  } catch (e) {
    return handleApiError(e);
  }
}
