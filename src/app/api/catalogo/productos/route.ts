import { handleApiError, ok } from "@/lib/api";
import { requireModule } from "@/lib/auth/guards";
import { cargaActiva } from "@/lib/catalogo/cargas";
import { CAMPOS_CATALOGO } from "@/lib/catalogo/tipos";
import { connectDB } from "@/lib/db";
import { fechaISO } from "@/lib/retail/normalize";
import { CatalogProduct } from "@/models/CatalogProduct";

// GET /api/catalogo/productos — TODAS las filas de la carga activa.
//
// Sin paginar y sin buscar en el servidor, a propósito.
//
// El buscador de este módulo es el de la pestaña Productos de la ficha del
// retailer: filtra en cada tecla, sin debounce. Eso sólo se puede replicar con
// las filas ya en memoria; paginando en el servidor haría falta un fetch por
// pulsación y la sensación sería justo la contraria.
//
// La escala lo permite con mucho margen: el catálogo son ~140 productos, no las
// 15 mil filas del reporte de ventas que forzaron la paginación en servidor en
// retail. Aun así las filas viajan como ARREGLOS y no como objetos, en el orden
// que dice CAMPOS_CATALOGO —el mismo recurso, y por el mismo motivo, que
// /api/retail/analisis/filas—: repetir el nombre de cada campo en cada fila es
// la mayor parte del JSON.
//
// Si el catálogo llegara a decenas de miles de filas, ESTE es el punto donde
// habría que introducir paginación en servidor; el tope de MAX_FILAS_CATALOGO
// está puesto justo antes de que eso haga falta.
export async function GET() {
  try {
    await requireModule("catalogo");
    await connectDB();

    const carga = await cargaActiva();
    if (!carga) {
      return ok({ carga: null, campos: CAMPOS_CATALOGO, filas: [], total: 0 });
    }

    const docs = await CatalogProduct.find({ loadId: carga.loadId })
      // Orden total por el índice único (loadId, item): sin un orden total, dos
      // filas empatadas podrían salir en dos páginas o en ninguna.
      .sort({ item: 1 })
      .select({
        _id: 0,
        item: 1,
        description: 1,
        salesUnit: 1,
        status: 1,
        line: 1,
        upc: 1,
        launchDate: 1,
        launchDateText: 1,
      })
      .lean();

    const filas = docs.map((d) =>
      CAMPOS_CATALOGO.map((c) =>
        c === "launchDate" ? (d.launchDate ? fechaISO(d.launchDate) : null) : (d[c] ?? null)
      )
    );

    return ok({
      carga: {
        loadId: carga.loadId,
        filename: carga.filename,
        finalizadaEl: carga.finalizedAt?.toISOString() ?? null,
      },
      campos: CAMPOS_CATALOGO,
      filas,
      total: filas.length,
    });
  } catch (e) {
    return handleApiError(e);
  }
}
