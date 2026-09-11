import type { NextRequest } from "next/server";
import { ApiError, handleApiError, ok, parseQuery } from "@/lib/api";
import { cargaActiva } from "@/lib/catalogo/cargas";
import { normalizarItem } from "@/lib/catalogo/normalizar";
import type { FichaProducto, MapeoConVentas } from "@/lib/catalogo/tipos";
import { claveVenta, ventasPorCanal } from "@/lib/catalogo/ventas";
import { requireModule } from "@/lib/auth/guards";
import { connectDB } from "@/lib/db";
import { fechaISO } from "@/lib/retail/normalize";
import { productoQuerySchema } from "@/lib/validation/catalogo";
import { CatalogProduct } from "@/models/CatalogProduct";
import { ProductMapping } from "@/models/ProductMapping";

// GET /api/catalogo/producto?item=PTAL001 — la ficha del producto.
//
// Todo lo que la tabla no muestra, más el mapeo por cadena y las unidades
// vendidas de cada una.
//
// El Item viaja como query y no como segmento de ruta: el vocabulario lo pone
// quien mantiene el Excel, y un código con punto o barra rompería el enrutado.
export async function GET(request: NextRequest) {
  try {
    await requireModule("catalogo");
    const q = parseQuery(request.url, productoQuerySchema);
    await connectDB();

    const carga = await cargaActiva();
    if (!carga) {
      throw new ApiError(404, "SIN_CATALOGO", "Todavía no se ha cargado ningún catálogo.");
    }

    // Se normaliza igual que al cargar: si no, un Item con espacios o en
    // minúsculas no encontraría su propio producto.
    const item = normalizarItem(q.item);
    const producto = await CatalogProduct.findOne({ loadId: carga.loadId, item })
      .select({ _id: 0, loadId: 0 })
      .lean();
    if (!producto) {
      throw new ApiError(404, "PRODUCTO_NO_ENCONTRADO", `No hay ningún producto «${item}».`);
    }

    const mapeos = await ProductMapping.find({ loadId: carga.loadId, sku: item })
      .sort({ channel: 1 })
      .select({ _id: 0, loadId: 0, sku: 0 })
      .lean();

    const ventas = await ventasPorCanal(mapeos);

    const conVentas: MapeoConVentas[] = mapeos.map((m) => ({
      channel: m.channel,
      channelName: m.channelName || m.channel,
      knownRetailer: m.knownRetailer,
      customerCode: m.customerCode,
      customerCodeNum: m.customerCodeNum,
      description: m.description,
      ventas:
        m.customerCodeNum !== null
          ? (ventas.get(claveVenta(m.channel, m.customerCodeNum)) ?? null)
          : null,
    }));

    const ficha: FichaProducto = {
      producto: {
        item: producto.item,
        description: producto.description,
        ecom: producto.ecom,
        trello: producto.trello,
        salesUnit: producto.salesUnit,
        status: producto.status,
        line: producto.line,
        upc: producto.upc,
        satCode: producto.satCode,
        tariffCode: producto.tariffCode,
        suv: producto.suv,
        grammage: producto.grammage,
        shelfLifeMonths: producto.shelfLifeMonths,
        launchDate: producto.launchDate ? fechaISO(producto.launchDate) : null,
        launchDateText: producto.launchDateText,
        suppliers: producto.suppliers,
        rowNumber: producto.rowNumber,
      },
      mapeos: conVentas,
      totales: {
        unidades: conVentas.reduce((n, m) => n + (m.ventas?.unidades ?? 0), 0),
        importe: conVentas.reduce((n, m) => n + (m.ventas?.importe ?? 0), 0),
        canalesConVenta: conVentas.filter((m) => (m.ventas?.unidades ?? 0) > 0).length,
      },
    };

    return ok(ficha);
  } catch (e) {
    return handleApiError(e);
  }
}
