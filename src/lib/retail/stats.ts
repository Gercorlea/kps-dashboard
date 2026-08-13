import { connectDB } from "@/lib/db";
import { LineaOC } from "@/models/LineaOC";
import { StockCedis } from "@/models/StockCedis";
import { StockFarmacia } from "@/models/StockFarmacia";
import { Upload, type IResumenHoja } from "@/models/Upload";
import { VentaDiaria } from "@/models/VentaDiaria";
import { fechaISO } from "./normalize";

// Estadísticas para el overview del dashboard y la serie histórica (§10).

export const UMBRAL_MOH = 6; // meses de inventario considerados "altos"

export interface CargaResumen {
  id: string;
  filename: string;
  cutoffDate: string;
  status: string;
  filas: number;
  createdAt: string;
}

export interface ResumenDashboard {
  cargasDelMes: number;
  filasUltimoCorte: number;
  fillRatePromedio: number | null;
  skusMohAlto: number;
  ultimoCorte: string | null;
  coverage: { desde: string | null; hasta: string | null; cortes: number };
  ultimasCargas: CargaResumen[];
}

function sumarFilas(summary: Record<string, IResumenHoja> | undefined): number {
  if (!summary) return 0;
  return Object.values(summary).reduce((t, r) => t + (r?.inserted ?? 0), 0);
}

async function ultimoCorteDe(account: string): Promise<Date | null> {
  const doc = await Upload.findOne({ account, status: "processed" })
    .sort({ cutoffDate: -1 })
    .select({ cutoffDate: 1 })
    .lean();
  return doc ? new Date(doc.cutoffDate) : null;
}

async function fillRateEnCorte(account: string, corte: Date): Promise<number | null> {
  const [r] = await LineaOC.aggregate([
    { $match: { account, cutoffDate: corte } },
    {
      $group: {
        _id: null,
        pedidas: { $sum: { $ifNull: ["$allocatedQty", 0] } },
        entregadas: { $sum: { $ifNull: ["$deliveredQty", 0] } },
      },
    },
  ]);
  if (!r || r.pedidas <= 0) return null;
  return r.entregadas / r.pedidas;
}

async function inventarioTotal(account: string, corte: Date): Promise<number> {
  const [farma] = await StockFarmacia.aggregate([
    { $match: { account, cutoffDate: corte } },
    {
      $group: {
        _id: null,
        total: {
          $sum: {
            $add: [{ $ifNull: ["$unrestrictedStock", 0] }, { $ifNull: ["$pharmacyInTransit", 0] }],
          },
        },
      },
    },
  ]);
  const [cedis] = await StockCedis.aggregate([
    { $match: { account, cutoffDate: corte } },
    { $group: { _id: null, total: { $sum: { $ifNull: ["$realAvailabilityDC", 0] } } } },
  ]);
  return (farma?.total ?? 0) + (cedis?.total ?? 0);
}

// SKUs con MOH sobre el umbral: inventario por SKU al último corte contra
// la venta de los últimos 30 días. Inventario sin venta también cuenta.
async function contarSkusMohAlto(account: string, corte: Date): Promise<number> {
  const invPorSku = new Map<string, number>();
  const farma = await StockFarmacia.aggregate([
    { $match: { account, cutoffDate: corte } },
    {
      $group: {
        _id: "$sku",
        total: {
          $sum: {
            $add: [{ $ifNull: ["$unrestrictedStock", 0] }, { $ifNull: ["$pharmacyInTransit", 0] }],
          },
        },
      },
    },
  ]);
  for (const r of farma) invPorSku.set(String(r._id), r.total);
  const cedis = await StockCedis.aggregate([
    { $match: { account, cutoffDate: corte } },
    { $group: { _id: "$sku", total: { $sum: { $ifNull: ["$realAvailabilityDC", 0] } } } },
  ]);
  for (const r of cedis) {
    invPorSku.set(String(r._id), (invPorSku.get(String(r._id)) ?? 0) + r.total);
  }

  const desde = new Date(corte.getTime() - 30 * 24 * 60 * 60 * 1000);
  const ventas = await VentaDiaria.aggregate([
    { $match: { account, date: { $gte: desde, $lte: corte } } },
    { $group: { _id: "$sku", units: { $sum: "$units" } } },
  ]);
  const ventaPorSku = new Map(ventas.map((r) => [String(r._id), r.units as number]));

  let altos = 0;
  for (const [sku, inv] of invPorSku) {
    if (inv <= 0) continue;
    const units = ventaPorSku.get(sku) ?? 0;
    if (units === 0 || inv / units > UMBRAL_MOH) altos++;
  }
  return altos;
}

export async function resumenDashboard(account = "san-pablo"): Promise<ResumenDashboard> {
  await connectDB();

  const ahora = new Date();
  const inicioMes = new Date(Date.UTC(ahora.getUTCFullYear(), ahora.getUTCMonth(), 1));
  const cargasDelMes = await Upload.countDocuments({ account, createdAt: { $gte: inicioMes } });

  const ultimoCorte = await ultimoCorteDe(account);
  const cortes = await Upload.distinct("cutoffDate", { account, status: "processed" });

  const [rango] = await VentaDiaria.aggregate([
    { $match: { account } },
    { $group: { _id: null, min: { $min: "$date" }, max: { $max: "$date" } } },
  ]);

  let filasUltimoCorte = 0;
  let fillRatePromedio: number | null = null;
  let skusMohAlto = 0;
  if (ultimoCorte) {
    const uploadsCorte = await Upload.find({ account, status: "processed", cutoffDate: ultimoCorte })
      .select({ summary: 1 })
      .lean();
    filasUltimoCorte = uploadsCorte.reduce((t, u) => t + sumarFilas(u.summary), 0);
    fillRatePromedio = await fillRateEnCorte(account, ultimoCorte);
    skusMohAlto = await contarSkusMohAlto(account, ultimoCorte);
  }

  const ultimas = await Upload.find({ account })
    .sort({ createdAt: -1 })
    .limit(5)
    .lean();

  return {
    cargasDelMes,
    filasUltimoCorte,
    fillRatePromedio,
    skusMohAlto,
    ultimoCorte: ultimoCorte ? fechaISO(ultimoCorte) : null,
    coverage: {
      desde: rango ? fechaISO(new Date(rango.min)) : null,
      hasta: rango ? fechaISO(new Date(rango.max)) : null,
      cortes: cortes.length,
    },
    ultimasCargas: ultimas.map((u) => ({
      id: String(u._id),
      filename: u.filename,
      cutoffDate: fechaISO(new Date(u.cutoffDate)),
      status: u.status,
      filas: sumarFilas(u.summary),
      createdAt: new Date(u.createdAt).toISOString(),
    })),
  };
}

// --- Serie histórica multi-corte (§10 /retail/historico) ---------------

export interface SerieHistorica {
  ventasPorSemana: Array<{ semana: string; units: number }>;
  inventarioPorCorte: Array<{ corte: string; inventario: number; moh: number | null }>;
  fillRatePorCorte: Array<{ corte: string; fillRate: number | null }>;
}

export async function serieHistorica(
  account: string,
  desde?: string,
  hasta?: string
): Promise<SerieHistorica> {
  await connectDB();
  const filtroFecha: Record<string, Date> = {};
  if (desde) filtroFecha.$gte = new Date(`${desde}T00:00:00.000Z`);
  if (hasta) filtroFecha.$lte = new Date(`${hasta}T00:00:00.000Z`);
  const matchVentas = {
    account,
    ...(Object.keys(filtroFecha).length ? { date: filtroFecha } : {}),
  };

  const semanas = await VentaDiaria.aggregate([
    { $match: matchVentas },
    {
      $group: {
        _id: {
          $dateTrunc: { date: "$date", unit: "week", startOfWeek: "monday" },
        },
        units: { $sum: "$units" },
      },
    },
    { $sort: { _id: 1 } },
  ]);

  const filtroCorte = { account, status: "processed" as const };
  const cortesTodos = (await Upload.distinct("cutoffDate", filtroCorte)) as Date[];
  const cortes = cortesTodos
    .map((c) => new Date(c))
    .filter(
      (c) =>
        (!filtroFecha.$gte || c >= filtroFecha.$gte) &&
        (!filtroFecha.$lte || c <= filtroFecha.$lte)
    )
    .sort((a, b) => a.getTime() - b.getTime());

  const inventarioPorCorte: SerieHistorica["inventarioPorCorte"] = [];
  const fillRatePorCorte: SerieHistorica["fillRatePorCorte"] = [];
  for (const corte of cortes) {
    const inventario = await inventarioTotal(account, corte);
    const desde30 = new Date(corte.getTime() - 30 * 24 * 60 * 60 * 1000);
    const [venta30] = await VentaDiaria.aggregate([
      { $match: { account, date: { $gte: desde30, $lte: corte } } },
      { $group: { _id: null, units: { $sum: "$units" } } },
    ]);
    const unidades30 = venta30?.units ?? 0;
    inventarioPorCorte.push({
      corte: fechaISO(corte),
      inventario,
      moh: unidades30 > 0 ? inventario / unidades30 : null,
    });
    fillRatePorCorte.push({ corte: fechaISO(corte), fillRate: await fillRateEnCorte(account, corte) });
  }

  return {
    ventasPorSemana: semanas.map((s) => ({
      semana: fechaISO(new Date(s._id)),
      units: s.units,
    })),
    inventarioPorCorte,
    fillRatePorCorte,
  };
}
