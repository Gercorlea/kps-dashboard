import { ApiError, handleApiError, ok, parseJson, parseQuery } from "@/lib/api";
import { requireModule } from "@/lib/auth/guards";
import { cargaActiva } from "@/lib/catalogo/cargas";
import { productosSinAlta } from "@/lib/catalogo/faltantes";
import { codigoNumerico, normalizarItem } from "@/lib/catalogo/normalizar";
import { CAMPOS_FALTANTES } from "@/lib/catalogo/tipos";
import { connectDB } from "@/lib/db";
import { nombreRetailer } from "@/lib/retail/retailers";
import { altaFaltanteSchema, faltantesQuerySchema } from "@/lib/validation/retail";
import { CatalogLoad } from "@/models/CatalogLoad";
import { CatalogProduct } from "@/models/CatalogProduct";
import { ProductMapping } from "@/models/ProductMapping";

// Los productos del catálogo de KPS que un retailer todavía no tiene dados de
// alta, y el alta desde la propia tabla.
//
// El guard es "retail" y no "catalogo" a propósito. Lo que se sirve no es el
// catálogo: es lo que le falta por listar a un retailer, y el sujeto es el
// retailer. Los permisos se dan por PÁGINA (ver lib/rbac.ts) y ésta es
// /retail/[retailer]; exigir además "catalogo" dejaría la pestaña en un 403
// permanente justo para el usuario de retail al que va dirigida.
//
// Para que eso sea cierto y no una excusa, la respuesta va podada: nada de
// loadId, filename, quién subió la carga ni incidencias. Sólo la fecha, para
// poder decir de qué catálogo se habla. Lo demás sigue siendo exclusivo de
// /api/catalogo/* bajo su propio módulo.
//
// Las consultas viven aquí y no en lib/catalogo/faltantes.ts —igual que en
// /api/catalogo/mapeo y /api/catalogo/resumen— porque ese módulo lo importa
// también el componente de cliente: un import de modelo allí arrastraría
// Mongoose al bundle del navegador.

/** Los campos con los que se lee y se escribe un producto del catálogo. */
const PROYECCION_PRODUCTO = { _id: 0, item: 1, description: 1, status: 1 } as const;

// GET /api/retail/faltantes?account=walmart
//
// Sin paginar: son ~130 productos y con ellos en el navegador el buscador
// filtra en cada tecla. Es el mismo trato, y por el mismo motivo, que
// /api/catalogo/productos. Las filas viajan como ARREGLOS en el orden de
// CAMPOS_FALTANTES para no repetir el nombre de cada campo en cada fila.
export async function GET(req: Request) {
  try {
    await requireModule("retail");
    const { account } = parseQuery(req.url, faltantesQuerySchema);
    await connectDB();

    // Ninguna lectura del catálogo vale sin el loadId de la carga activa:
    // durante una subida conviven dos catálogos completos en la colección.
    // Que no haya ninguna no es un error —el retailer existe, lo que falta es
    // el catálogo—, así que se contesta 200 con la lista vacía.
    const carga = await cargaActiva();
    if (!carga) {
      return ok({ catalogo: null, campos: CAMPOS_FALTANTES, filas: [], total: 0 });
    }

    const loadId = carga.loadId;

    const [productos, mapeos] = await Promise.all([
      // Índice único (loadId, item): el sort sale del mismo recorrido, sin
      // ordenar en memoria, y es un orden TOTAL, así que la paginación del
      // navegador no puede repetir una fila ni saltársela.
      CatalogProduct.find({ loadId }).sort({ item: 1 }).select(PROYECCION_PRODUCTO).lean(),
      // Índice (loadId, channel, sku): trae sólo las filas de ESTE canal, no la
      // hoja de mapeo completa como hace /api/catalogo/mapeo.
      //
      // El `channel` del mapeo y el id del retailer son el MISMO string: los dos
      // salen de RETAILERS[].id —canales.ts lo impone al leer el Excel—, así que
      // el id sirve de clave sin traducción.
      ProductMapping.find({ loadId, channel: account })
        .select({ _id: 0, sku: 1, customerCode: 1 })
        .lean(),
    ]);

    const filas = productosSinAlta(productos, mapeos);

    return ok({
      catalogo: { finalizadaEl: carga.finalizedAt?.toISOString() ?? null },
      campos: CAMPOS_FALTANTES,
      filas: filas.map((f) => CAMPOS_FALTANTES.map((c) => f[c])),
      total: filas.length,
    });
  } catch (e) {
    return handleApiError(e);
  }
}

// POST /api/retail/faltantes — da de alta un producto en un retailer.
//
// Escribe una fila de mapeo en la carga ACTIVA, que es donde la leen tanto esta
// pestaña como /catalogo. Eso tiene una consecuencia que conviene tener
// presente: la próxima subida del Excel del catálogo reemplaza la carga entera
// y `barrerCargas()` borra sus filas, así que un alta hecha aquí desaparece con
// ella. Es deliberado —el Excel sigue siendo la fuente de verdad— y el alta de
// esta pestaña es el atajo para no esperar a la siguiente subida.
export async function POST(req: Request) {
  try {
    await requireModule("retail");
    const { account, item, customerCode } = await parseJson(req, altaFaltanteSchema);
    await connectDB();

    const carga = await cargaActiva();
    if (!carga) {
      throw new ApiError(
        409,
        "SIN_CATALOGO",
        "No hay un catálogo cargado: sin él no hay producto que dar de alta"
      );
    }

    const loadId = carga.loadId;
    // Misma normalización que al leer el Excel, para que el sku escrito aquí sea
    // el mismo string que el `item` del producto; si no, el alta se guardaría
    // como huérfana y el producto seguiría saliendo en la lista de faltantes.
    const sku = normalizarItem(item);

    // El producto tiene que existir en la carga activa. Sin esta comprobación,
    // un item inventado crearía una fila de mapeo que no mapea nada.
    const producto = await CatalogProduct.findOne({ loadId, item: sku })
      .select(PROYECCION_PRODUCTO)
      .lean();
    if (!producto) {
      throw new ApiError(404, "NO_ENCONTRADO", `${sku} no está en el catálogo activo`);
    }

    // Upsert sobre la clave del grano (loadId, sku, channel), que es el índice
    // único: darlo de alta dos veces actualiza el código en vez de fallar.
    const r = await ProductMapping.updateOne(
      { loadId, sku, channel: account },
      {
        $set: {
          channelName: nombreRetailer(account),
          knownRetailer: true,
          customerCode,
          // Se precalcula aquí, igual que al leer el archivo: es lo que permite
          // que el cruce con SalesReport.itemNbr sea una igualdad indexada.
          customerCodeNum: codigoNumerico(customerCode),
          description: producto.description,
        },
        $setOnInsert: { rowNumber: 0 },
      },
      { upsert: true }
    );

    // La cabecera de /catalogo lee `mappingCount` del documento de la carga, no
    // cuenta las filas: sin este $inc diría un mapeo de menos que los que la
    // pestaña Mapeo lista justo debajo.
    if (r.upsertedCount > 0) {
      await CatalogLoad.updateOne({ loadId }, { $inc: { mappingCount: 1 } });
    }

    return ok({
      item: sku,
      description: producto.description,
      customerCode,
      /** false = ya tenía fila de mapeo y sólo se le cambió el código. */
      creado: r.upsertedCount > 0,
    });
  } catch (e) {
    return handleApiError(e);
  }
}
