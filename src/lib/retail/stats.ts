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
  fechaCorte: string;
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
  cobertura: { desde: string | null; hasta: string | null; cortes: number };
  ultimasCargas: CargaResumen[];
}

function sumarFilas(resumen: Record<string, IResumenHoja> | undefined): number {
  if (!resumen) return 0;
  return Object.values(resumen).reduce((t, r) => t + (r?.insertadas ?? 0), 0);
}

async function ultimoCorteDe(cuenta: string): Promise<Date | null> {
  const doc = await Upload.findOne({ cuenta, status: "procesado" })
    .sort({ fechaCorte: -1 })
    .select({ fechaCorte: 1 })
    .lean();
  return doc ? new Date(doc.fechaCorte) : null;
}

async function fillRateEnCorte(cuenta: string, corte: Date): Promise<number | null> {
  const [r] = await LineaOC.aggregate([
    { $match: { cuenta, fechaCorte: corte } },
    {
      $group: {
        _id: null,
        pedidas: { $sum: { $ifNull: ["$cantidadReparto", 0] } },
        entregadas: { $sum: { $ifNull: ["$cantidadEntregada", 0] } },
      },
    },
  ]);
  if (!r || r.pedidas <= 0) return null;
  return r.entregadas / r.pedidas;
}

async function inventarioTotal(cuenta: string, corte: Date): Promise<number> {
  const [farma] = await StockFarmacia.aggregate([
    { $match: { cuenta, fechaCorte: corte } },
    {
      $group: {
        _id: null,
        total: {
          $sum: {
            $add: [{ $ifNull: ["$libreUtilizacion", 0] }, { $ifNull: ["$transitoFarma", 0] }],
          },
        },
      },
    },
  ]);
  const [cedis] = await StockCedis.aggregate([
    { $match: { cuenta, fechaCorte: corte } },
    { $group: { _id: null, total: { $sum: { $ifNull: ["$disponibilidadRealCD", 0] } } } },
  ]);
  return (farma?.total ?? 0) + (cedis?.total ?? 0);
}

// SKUs con MOH sobre el umbral: inventario por SKU al último corte contra
// la venta de los últimos 30 días. Inventario sin venta también cuenta.
async function contarSkusMohAlto(cuenta: string, corte: Date): Promise<number> {
  const invPorSku = new Map<string, number>();
  const farma = await StockFarmacia.aggregate([
    { $match: { cuenta, fechaCorte: corte } },
    {
      $group: {
        _id: "$sku",
        total: {
          $sum: {
            $add: [{ $ifNull: ["$libreUtilizacion", 0] }, { $ifNull: ["$transitoFarma", 0] }],
          },
        },
      },
    },
  ]);
  for (const r of farma) invPorSku.set(String(r._id), r.total);
  const cedis = await StockCedis.aggregate([
    { $match: { cuenta, fechaCorte: corte } },
    { $group: { _id: "$sku", total: { $sum: { $ifNull: ["$disponibilidadRealCD", 0] } } } },
  ]);
  for (const r of cedis) {
    invPorSku.set(String(r._id), (invPorSku.get(String(r._id)) ?? 0) + r.total);
  }

  const desde = new Date(corte.getTime() - 30 * 24 * 60 * 60 * 1000);
  const ventas = await VentaDiaria.aggregate([
    { $match: { cuenta, fecha: { $gte: desde, $lte: corte } } },
    { $group: { _id: "$sku", unidades: { $sum: "$unidades" } } },
  ]);
  const ventaPorSku = new Map(ventas.map((r) => [String(r._id), r.unidades as number]));

  let altos = 0;
  for (const [sku, inv] of invPorSku) {
    if (inv <= 0) continue;
    const unidades = ventaPorSku.get(sku) ?? 0;
    if (unidades === 0 || inv / unidades > UMBRAL_MOH) altos++;
  }
  return altos;
}

export async function resumenDashboard(cuenta = "san-pablo"): Promise<ResumenDashboard> {
  await connectDB();

  const ahora = new Date();
  const inicioMes = new Date(Date.UTC(ahora.getUTCFullYear(), ahora.getUTCMonth(), 1));
  const cargasDelMes = await Upload.countDocuments({ cuenta, createdAt: { $gte: inicioMes } });

  const ultimoCorte = await ultimoCorteDe(cuenta);
  const cortes = await Upload.distinct("fechaCorte", { cuenta, status: "procesado" });

  const [rango] = await VentaDiaria.aggregate([
    { $match: { cuenta } },
    { $group: { _id: null, min: { $min: "$fecha" }, max: { $max: "$fecha" } } },
  ]);

  let filasUltimoCorte = 0;
  let fillRatePromedio: number | null = null;
  let skusMohAlto = 0;
  if (ultimoCorte) {
    const uploadsCorte = await Upload.find({ cuenta, status: "procesado", fechaCorte: ultimoCorte })
      .select({ resumen: 1 })
      .lean();
    filasUltimoCorte = uploadsCorte.reduce((t, u) => t + sumarFilas(u.resumen), 0);
    fillRatePromedio = await fillRateEnCorte(cuenta, ultimoCorte);
    skusMohAlto = await contarSkusMohAlto(cuenta, ultimoCorte);
  }

  const ultimas = await Upload.find({ cuenta })
    .sort({ createdAt: -1 })
    .limit(5)
    .lean();

  return {
    cargasDelMes,
    filasUltimoCorte,
    fillRatePromedio,
    skusMohAlto,
    ultimoCorte: ultimoCorte ? fechaISO(ultimoCorte) : null,
    cobertura: {
      desde: rango ? fechaISO(new Date(rango.min)) : null,
      hasta: rango ? fechaISO(new Date(rango.max)) : null,
      cortes: cortes.length,
    },
    ultimasCargas: ultimas.map((u) => ({
      id: String(u._id),
      filename: u.filename,
      fechaCorte: fechaISO(new Date(u.fechaCorte)),
      status: u.status,
      filas: sumarFilas(u.resumen),
      createdAt: new Date(u.createdAt).toISOString(),
    })),
  };
}

// --- Serie histórica multi-corte (§10 /retail/historico) ---------------

export interface SerieHistorica {
  ventasPorSemana: Array<{ semana: string; unidades: number }>;
  inventarioPorCorte: Array<{ corte: string; inventario: number; moh: number | null }>;
  fillRatePorCorte: Array<{ corte: string; fillRate: number | null }>;
}

export async function serieHistorica(
  cuenta: string,
  desde?: string,
  hasta?: string
): Promise<SerieHistorica> {
  await connectDB();
  const filtroFecha: Record<string, Date> = {};
  if (desde) filtroFecha.$gte = new Date(`${desde}T00:00:00.000Z`);
  if (hasta) filtroFecha.$lte = new Date(`${hasta}T00:00:00.000Z`);
  const matchVentas = {
    cuenta,
    ...(Object.keys(filtroFecha).length ? { fecha: filtroFecha } : {}),
  };

  const semanas = await VentaDiaria.aggregate([
    { $match: matchVentas },
    {
      $group: {
        _id: {
          $dateTrunc: { date: "$fecha", unit: "week", startOfWeek: "monday" },
        },
        unidades: { $sum: "$unidades" },
      },
    },
    { $sort: { _id: 1 } },
  ]);

  const filtroCorte = { cuenta, status: "procesado" as const };
  const cortesTodos = (await Upload.distinct("fechaCorte", filtroCorte)) as Date[];
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
    const inventario = await inventarioTotal(cuenta, corte);
    const desde30 = new Date(corte.getTime() - 30 * 24 * 60 * 60 * 1000);
    const [venta30] = await VentaDiaria.aggregate([
      { $match: { cuenta, fecha: { $gte: desde30, $lte: corte } } },
      { $group: { _id: null, unidades: { $sum: "$unidades" } } },
    ]);
    const unidades30 = venta30?.unidades ?? 0;
    inventarioPorCorte.push({
      corte: fechaISO(corte),
      inventario,
      moh: unidades30 > 0 ? inventario / unidades30 : null,
    });
    fillRatePorCorte.push({ corte: fechaISO(corte), fillRate: await fillRateEnCorte(cuenta, corte) });
  }

  return {
    ventasPorSemana: semanas.map((s) => ({
      semana: fechaISO(new Date(s._id)),
      unidades: s.unidades,
    })),
    inventarioPorCorte,
    fillRatePorCorte,
  };
}
