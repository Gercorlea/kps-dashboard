// Consultas de SOLO LECTURA sobre las colecciones de Retail, para exponerse
// como herramienta a KPS AI. Whitelist de colecciones y campos; sin
// operadores crudos de Mongo ($where, $function…), límites acotados.
import type { Model } from "mongoose";
import { connectDB } from "@/lib/db";
import { DailyForecast } from "@/models/DailyForecast";
import { PurchaseOrderLine } from "@/models/PurchaseOrderLine";
import { WeeklyForecast } from "@/models/WeeklyForecast";
import { DcStock } from "@/models/DcStock";
import { PharmacyStock } from "@/models/PharmacyStock";
import { Upload } from "@/models/Upload";
import { DailySale } from "@/models/DailySale";

export const COLECCIONES_RETAIL = [
  "sales",
  "weeklyForecast",
  "dailyForecast",
  "dcStock",
  "pharmacyStock",
  "purchaseOrders",
  "uploads",
] as const;

export type ColeccionRetail = (typeof COLECCIONES_RETAIL)[number];

/* eslint-disable @typescript-eslint/no-explicit-any */
const MODELOS: Record<ColeccionRetail, Model<any>> = {
  sales: DailySale,
  weeklyForecast: WeeklyForecast,
  dailyForecast: DailyForecast,
  dcStock: DcStock,
  pharmacyStock: PharmacyStock,
  purchaseOrders: PurchaseOrderLine,
  uploads: Upload,
};
/* eslint-enable @typescript-eslint/no-explicit-any */

// Campos permitidos en filtros y agrupaciones (evita $where y campos raros).
const CAMPOS = new Set([
  "account", "date", "cutoffDate", "weekStart", "sku", "storeCode",
  "storeName", "description", "brand", "division", "vendorCode",
  "vendorName", "vendorName", "units", "value", "poStatus",
  "buyer", "purchaseDoc", "fillRate", "allocatedQty",
  "deliveredQty", "unrestrictedStock", "pharmacyInTransit", "inventoryLevel",
  "realAvailabilityDC", "targetStock", "reorderPoint", "status", "filename",
]);

const LIMITE_MAX = 50;

export interface ConsultaRetail {
  coleccion: ColeccionRetail;
  filtros?: Array<{
    field: string;
    operador: "igual" | "contiene" | "mayorQue" | "menorQue";
    value: string | number;
  }>;
  agruparPor?: string; // devuelve totales por ese campo
  sumar?: string; // campo numérico a sumar en la agrupación
  ordenarPor?: string;
  dir?: "asc" | "desc";
  limite?: number;
}

export interface ResultadoRetail {
  total: number;
  devueltas: number;
  filas: Record<string, unknown>[];
}

function construirFiltro(consulta: ConsultaRetail): Record<string, unknown> {
  const filtro: Record<string, unknown> = {};
  for (const f of consulta.filtros ?? []) {
    if (!CAMPOS.has(f.field)) continue;
    if (f.operador === "contiene") {
      filtro[f.field] = {
        $regex: String(f.value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        $options: "i",
      };
    } else if (f.operador === "mayorQue") {
      filtro[f.field] = { $gt: f.value };
    } else if (f.operador === "menorQue") {
      filtro[f.field] = { $lt: f.value };
    } else {
      // Las fechas llegan como texto ISO; el resto tal cual.
      filtro[f.field] =
        typeof f.value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(f.value)
          ? new Date(`${f.value}T00:00:00.000Z`)
          : f.value;
    }
  }
  return filtro;
}

export async function consultarRetail(consulta: ConsultaRetail): Promise<ResultadoRetail> {
  await connectDB();
  const model = MODELOS[consulta.coleccion];
  const filtro = construirFiltro(consulta);
  const limite = Math.min(Math.max(consulta.limite ?? 10, 1), LIMITE_MAX);

  // Modo agregado: totales por campo (ej. unidades por marca).
  if (consulta.agruparPor && CAMPOS.has(consulta.agruparPor)) {
    const campoSuma = consulta.sumar && CAMPOS.has(consulta.sumar) ? consulta.sumar : null;
    const filas = await model.aggregate([
      { $match: filtro },
      {
        $group: {
          _id: `$${consulta.agruparPor}`,
          ...(campoSuma ? { total: { $sum: `$${campoSuma}` } } : {}),
          registros: { $sum: 1 },
        },
      },
      { $sort: campoSuma ? { total: -1 } : { registros: -1 } },
      { $limit: limite },
    ]);
    return {
      total: filas.length,
      devueltas: filas.length,
      filas: filas.map((f) => ({
        [consulta.agruparPor!]: f._id,
        ...(campoSuma ? { [campoSuma]: f.total } : {}),
        registros: f.registros,
      })),
    };
  }

  const total = await model.countDocuments(filtro);
  const orden =
    consulta.ordenarPor && CAMPOS.has(consulta.ordenarPor) ? consulta.ordenarPor : "_id";
  const filas = await model
    .find(filtro)
    .sort({ [orden]: consulta.dir === "asc" ? 1 : -1 })
    .limit(limite)
    .select({ uploadId: 0, __v: 0 })
    .lean();

  return {
    total,
    devueltas: filas.length,
    filas: filas.map((f) => ({ ...f, _id: String((f as { _id: unknown })._id) })),
  };
}
