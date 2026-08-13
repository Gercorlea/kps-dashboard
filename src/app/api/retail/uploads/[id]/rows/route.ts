import { isValidObjectId, type Model } from "mongoose";
import type { NextRequest } from "next/server";
import { ApiError, handleApiError, ok, parseQuery } from "@/lib/api";
import { requireModule } from "@/lib/auth/guards";
import { connectDB } from "@/lib/db";
import { rowsQuerySchema, type Hoja } from "@/lib/validation/retail";
import { ForecastDiario } from "@/models/ForecastDiario";
import { LineaOC } from "@/models/LineaOC";
import { PronosticoSemanal } from "@/models/PronosticoSemanal";
import { StockCedis } from "@/models/StockCedis";
import { StockFarmacia } from "@/models/StockFarmacia";
import { VentaDiaria } from "@/models/VentaDiaria";

/* eslint-disable @typescript-eslint/no-explicit-any */
const MODELO_POR_HOJA: Record<Hoja, Model<any>> = {
  CEDIS: StockCedis,
  VENTAS: VentaDiaria,
  PRONOSTICOS: PronosticoSemanal,
  FC_Mean: ForecastDiario,
  "Fill Rate": LineaOC,
  "Inv Farma": StockFarmacia,
};
/* eslint-enable @typescript-eslint/no-explicit-any */

// Ordenamiento permitido por hoja (se ignora cualquier otro campo).
const ORDEN_PERMITIDO = new Set([
  "date",
  "weekStart",
  "sku",
  "storeCode",
  "storeName",
  "brand",
  "units",
  "value",
  "description",
  "fillRate",
  "buyer",
  "poStatus",
  "purchaseDoc",
  "unrestrictedStock",
  "inventoryLevel",
  "realAvailabilityDC",
]);

const ORDEN_DEFECTO: Record<Hoja, string> = {
  CEDIS: "sku",
  VENTAS: "date",
  PRONOSTICOS: "weekStart",
  FC_Mean: "date",
  "Fill Rate": "orderDate",
  "Inv Farma": "storeCode",
};

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Tablas densas paginadas del lado del servidor: nunca 9,261 filas al
// cliente (§10 /retail/[uploadId]).
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requireModule("retail");
    const { id } = await params;
    if (!isValidObjectId(id)) throw new ApiError(404, "NO_ENCONTRADO", "Carga no encontrada");
    const q = parseQuery(request.url, rowsQuerySchema);

    await connectDB();
    const model = MODELO_POR_HOJA[q.sheet];
    const filtro: Record<string, unknown> = { uploadId: id };
    if (q.tienda) filtro.storeCode = q.tienda;
    if (q.brand) filtro.brand = q.brand;
    if (q.sku) filtro.sku = q.sku;
    if (q.buscar) {
      const rx = { $regex: escapeRegex(q.buscar), $options: "i" };
      filtro.$or = [{ description: rx }, { sku: rx }, { storeName: rx }, { vendorName: rx }];
    }

    const orden =
      q.orden && ORDEN_PERMITIDO.has(q.orden) ? q.orden : ORDEN_DEFECTO[q.sheet];
    const total = await model.countDocuments(filtro);
    const filas = await model
      .find(filtro)
      .sort({ [orden]: q.dir === "asc" ? 1 : -1, _id: 1 })
      .skip((q.page - 1) * q.limit)
      .limit(q.limit)
      .select({ uploadId: 0, account: 0 })
      .lean();

    // Facetas para filtros (marcas y tiendas presentes en la carga)
    const marcas = (await model.distinct("brand", { uploadId: id })) as string[];
    let tiendas: string[] = [];
    if (q.sheet !== "CEDIS" && q.sheet !== "Fill Rate") {
      tiendas = (await model.distinct("storeCode", { uploadId: id })) as string[];
    }

    return ok({
      filas: filas.map((f) => ({ ...f, _id: String((f as { _id: unknown })._id) })),
      total,
      pagina: q.page,
      paginas: Math.max(1, Math.ceil(total / q.limit)),
      marcas: marcas.sort(),
      tiendas: tiendas.sort(),
    });
  } catch (e) {
    return handleApiError(e);
  }
}
