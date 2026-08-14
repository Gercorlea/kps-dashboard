import { connectDB } from "@/lib/db";
import { PurchaseOrderLine } from "@/models/PurchaseOrderLine";
import { DcStock } from "@/models/DcStock";
import { PharmacyStock } from "@/models/PharmacyStock";
import { Upload } from "@/models/Upload";
import { DailySale } from "@/models/DailySale";
import { fechaISO } from "./normalize";

// Scorecard (§8): reporte CALCULADO desde las colecciones persistidas.
// Los párrafos narrativos se generan por plantilla determinista a partir
// de los números — nunca con el LLM: las cifras de un documento que se
// presenta a un cliente tienen que ser reproducibles.

export const CUENTA_NOMBRES: Record<string, string> = {
  "san-pablo": "San Pablo",
};

const MESES_ES = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];

const TOP_SKUS_POR_MARCA = 5;
const TOP_TIENDAS = 10;

// --- métricas puras (testeadas) ----------------------------------------

// Inc vs AA: (actual / anterior) - 1. Divisor 0 o sin dato → null (la UI
// muestra "—", nunca ∞ ni 100%) (§8.1).
export function incVsAA(actual: number | null, anterior: number | null): number | null {
  if (actual === null || anterior === null || anterior === 0) return null;
  return actual / anterior - 1;
}

// MOH (meses de inventario): inventario / unidades del mes. Unidades 0 → null.
export function moh(inventario: number | null, unidadesMes: number | null): number | null {
  if (inventario === null || unidadesMes === null || unidadesMes === 0) return null;
  return inventario / unidadesMes;
}

// --- formato determinista ----------------------------------------------

const nf = new Intl.NumberFormat("es-MX", { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat("es-MX", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

export function fmtUnidades(v: number | null): string {
  return v === null ? "—" : nf.format(v);
}

export function fmtPct(v: number | null): string {
  if (v === null) return "—";
  const pct = v * 100;
  const signo = pct > 0 ? "+" : "";
  return `${signo}${nf1.format(pct)}%`;
}

export function fmtMoh(v: number | null): string {
  return v === null ? "—" : nf1.format(v);
}

// --- tipos del reporte --------------------------------------------------

export interface FilaScorecard {
  etiqueta: string;
  unidadesAnterior: number | null;
  unidadesActual: number | null;
  inventario: number | null;
  incVsAA: number | null;
  moh: number | null;
  esSubtotal?: boolean;
}

export interface FilaFillRate {
  etiqueta: string;
  pedidas: number;
  entregadas: number;
  fillRate: number | null; // fracción
  esSubtotal?: boolean;
}

export interface BloqueScorecard {
  id: string;
  title: string;
  narrativa: string;
  sinHistorico: boolean;
  filas: FilaScorecard[];
  filasFillRate?: FilaFillRate[];
}

export interface CoberturaDatos {
  desde: string | null;
  hasta: string | null;
  cortes: string[];
  mesesCompletos: string[];
  mesesParciales: string[];
}

export interface Scorecard {
  account: string;
  cuentaNombre: string;
  hasta: string | null;
  ultimoCorte: string | null;
  coverage: CoberturaDatos;
  bloques: BloqueScorecard[];
}

// --- agregaciones auxiliares -------------------------------------------

interface Periodo {
  inicio: Date;
  fin: Date;
}

function utc(anio: number, mes0: number, dia: number): Date {
  return new Date(Date.UTC(anio, mes0, dia));
}

async function unidadesPor(
  account: string,
  periodo: Periodo,
  campos: Record<string, string>
): Promise<Array<Record<string, unknown> & { units: number }>> {
  const grupo: Record<string, unknown> = {};
  for (const [alias, field] of Object.entries(campos)) grupo[alias] = `$${field}`;
  const res = await DailySale.aggregate([
    { $match: { account, date: { $gte: periodo.inicio, $lte: periodo.fin } } },
    { $group: { _id: grupo, units: { $sum: "$units" } } },
  ]);
  return res.map((r) => ({ ...(r._id as Record<string, unknown>), units: r.units as number }));
}

async function inventarioTotalEnCorte(account: string, corte: Date): Promise<number | null> {
  const [farma] = await PharmacyStock.aggregate([
    { $match: { account, cutoffDate: corte } },
    {
      $group: {
        _id: null,
        total: {
          $sum: {
            $add: [{ $ifNull: ["$unrestrictedStock", 0] }, { $ifNull: ["$pharmacyInTransit", 0] }],
          },
        },
        n: { $sum: 1 },
      },
    },
  ]);
  const [cedis] = await DcStock.aggregate([
    { $match: { account, cutoffDate: corte } },
    { $group: { _id: null, total: { $sum: { $ifNull: ["$realAvailabilityDC", 0] } }, n: { $sum: 1 } } },
  ]);
  if (!farma && !cedis) return null;
  return (farma?.total ?? 0) + (cedis?.total ?? 0);
}

async function inventarioPorCampo(
  account: string,
  corte: Date,
  field: "brand" | "sku" | "storeCode"
): Promise<Map<string, number>> {
  const mapa = new Map<string, number>();
  const farma = await PharmacyStock.aggregate([
    { $match: { account, cutoffDate: corte } },
    {
      $group: {
        _id: `$${field}`,
        total: {
          $sum: {
            $add: [{ $ifNull: ["$unrestrictedStock", 0] }, { $ifNull: ["$pharmacyInTransit", 0] }],
          },
        },
      },
    },
  ]);
  for (const r of farma) mapa.set(String(r._id), r.total as number);
  if (field !== "storeCode") {
    // El CEDIS no tiene tienda: solo aplica a marca y SKU.
    const cedis = await DcStock.aggregate([
      { $match: { account, cutoffDate: corte } },
      { $group: { _id: `$${field}`, total: { $sum: { $ifNull: ["$realAvailabilityDC", 0] } } } },
    ]);
    for (const r of cedis) {
      mapa.set(String(r._id), (mapa.get(String(r._id)) ?? 0) + (r.total as number));
    }
  }
  return mapa;
}

// --- generación ---------------------------------------------------------

export async function generarScorecard(account: string, hastaStr?: string): Promise<Scorecard> {
  await connectDB();
  const cuentaNombre = CUENTA_NOMBRES[account] ?? account;

  const cortesDocs = await Upload.find({
    account,
    status: "processed",
    ...(hastaStr ? { cutoffDate: { $lte: new Date(`${hastaStr}T00:00:00.000Z`) } } : {}),
  })
    .select({ cutoffDate: 1 })
    .lean();
  const cortes = [...new Set(cortesDocs.map((d) => new Date(d.cutoffDate).getTime()))]
    .sort((a, b) => a - b)
    .map((t) => new Date(t));

  if (cortes.length === 0) {
    return {
      account,
      cuentaNombre,
      hasta: hastaStr ?? null,
      ultimoCorte: null,
      coverage: { desde: null, hasta: null, cortes: [], mesesCompletos: [], mesesParciales: [] },
      bloques: [],
    };
  }

  const ultimoCorte = cortes[cortes.length - 1];
  const hasta = hastaStr ? new Date(`${hastaStr}T00:00:00.000Z`) : ultimoCorte;
  const anioActual = hasta.getUTCFullYear();
  const anioAnterior = anioActual - 1;

  const periodoActual: Periodo = { inicio: utc(anioActual, 0, 1), fin: hasta };
  const periodoAnterior: Periodo = {
    inicio: utc(anioAnterior, 0, 1),
    fin: utc(anioAnterior, hasta.getUTCMonth(), hasta.getUTCDate()),
  };

  // Rango real de datos de venta (para cobertura y completitud de meses).
  const [rango] = await DailySale.aggregate([
    { $match: { account } },
    { $group: { _id: null, min: { $min: "$date" }, max: { $max: "$date" } } },
  ]);
  const minFecha: Date | null = rango ? new Date(rango.min) : null;
  const maxFecha: Date | null = rango ? new Date(rango.max) : null;

  // Unidades por mes (año actual + anterior en una sola pasada).
  const porMes = await DailySale.aggregate([
    { $match: { account, date: { $gte: periodoAnterior.inicio, $lte: hasta } } },
    {
      $group: {
        _id: { anio: { $year: "$date" }, mes: { $month: "$date" } },
        units: { $sum: "$units" },
      },
    },
  ]);
  const unidadesMes = new Map<string, number>();
  for (const r of porMes) unidadesMes.set(`${r._id.anio}-${r._id.mes}`, r.units);

  // Cobertura: meses completos vs parciales del año actual.
  const mesesCompletos: string[] = [];
  const mesesParciales: string[] = [];
  for (let m = 0; m <= hasta.getUTCMonth(); m++) {
    const tieneDatos = unidadesMes.has(`${anioActual}-${m + 1}`);
    if (!tieneDatos) continue;
    const inicioMes = utc(anioActual, m, 1);
    const finMes = utc(anioActual, m + 1, 0);
    const completo =
      minFecha !== null && maxFecha !== null && minFecha <= inicioMes && maxFecha >= finMes;
    (completo ? mesesCompletos : mesesParciales).push(MESES_ES[m]);
  }

  const mesesConDatosActual = mesesCompletos.length + mesesParciales.length;

  // Inventario por corte (cache) e inventario al cierre de cada mes.
  const invPorCorte = new Map<number, number | null>();
  async function invEnCorte(corte: Date): Promise<number | null> {
    const t = corte.getTime();
    if (!invPorCorte.has(t)) invPorCorte.set(t, await inventarioTotalEnCorte(account, corte));
    return invPorCorte.get(t) ?? null;
  }
  const inventarioActual = await invEnCorte(ultimoCorte);

  // --- Bloque 1: Mes / Unidades ---------------------------------------
  const filasMes: FilaScorecard[] = [];
  let totalActual = 0;
  let totalAnterior = 0;
  let hayAnterior = false;
  for (let m = 0; m <= hasta.getUTCMonth(); m++) {
    const uActual = unidadesMes.get(`${anioActual}-${m + 1}`) ?? null;
    const uAnterior = unidadesMes.get(`${anioAnterior}-${m + 1}`) ?? null;
    if (uActual === null && uAnterior === null) continue;
    if (uActual !== null) totalActual += uActual;
    if (uAnterior !== null) {
      totalAnterior += uAnterior;
      hayAnterior = true;
    }
    const finMes = utc(anioActual, m + 1, 0);
    const corteDelMes = [...cortes].reverse().find((c) => c <= finMes) ?? null;
    const invMes = corteDelMes ? await invEnCorte(corteDelMes) : null;
    const esParcial = mesesParciales.includes(MESES_ES[m]);
    filasMes.push({
      etiqueta: esParcial ? `${MESES_ES[m]} (parcial)` : MESES_ES[m],
      unidadesAnterior: uAnterior,
      unidadesActual: uActual,
      inventario: invMes,
      incVsAA: incVsAA(uActual, uAnterior),
      moh: moh(invMes, uActual),
    });
  }
  const unidadesMesPromedio = mesesConDatosActual > 0 ? totalActual / mesesConDatosActual : null;
  filasMes.push({
    etiqueta: "Total",
    unidadesAnterior: hayAnterior ? totalAnterior : null,
    unidadesActual: totalActual,
    inventario: inventarioActual,
    incVsAA: incVsAA(totalActual, hayAnterior ? totalAnterior : null),
    moh: moh(inventarioActual, unidadesMesPromedio),
    esSubtotal: true,
  });

  const incTotal = incVsAA(totalActual, hayAnterior ? totalAnterior : null);
  const mohTotal = moh(inventarioActual, unidadesMesPromedio);
  const narrativaMes =
    incTotal !== null
      ? `Al cierre del periodo el crecimiento en ${cuentaNombre} es de ${fmtPct(incTotal)} vs. el año anterior. Actualmente se cuentan con ${fmtMoh(mohTotal)} meses de inventario.`
      : `Al cierre del periodo ${cuentaNombre} acumula ${fmtUnidades(totalActual)} unidades vendidas en ${anioActual}, sin histórico comparable del año anterior. Actualmente se cuentan con ${fmtMoh(mohTotal)} meses de inventario.`;

  // --- Bloque 2: Marca / Unidades --------------------------------------
  const marcasActual = await unidadesPor(account, periodoActual, { brand: "brand" });
  const marcasAnterior = await unidadesPor(account, periodoAnterior, { brand: "brand" });
  const anteriorPorMarca = new Map(
    marcasAnterior.map((r) => [String(r.brand), r.units])
  );
  const invPorMarca = await inventarioPorCampo(account, ultimoCorte, "brand");

  const filasMarca: FilaScorecard[] = marcasActual
    .sort((a, b) => b.units - a.units)
    .map((r) => {
      const brand = String(r.brand);
      const uAnterior = anteriorPorMarca.get(brand) ?? null;
      const inv = invPorMarca.get(brand) ?? null;
      const uMes = mesesConDatosActual > 0 ? r.units / mesesConDatosActual : null;
      return {
        etiqueta: brand,
        unidadesAnterior: uAnterior,
        unidadesActual: r.units,
        inventario: inv,
        incVsAA: incVsAA(r.units, uAnterior),
        moh: moh(inv, uMes),
      };
    });
  filasMarca.push({
    etiqueta: "Total",
    unidadesAnterior: hayAnterior ? totalAnterior : null,
    unidadesActual: totalActual,
    inventario: inventarioActual,
    incVsAA: incTotal,
    moh: mohTotal,
    esSubtotal: true,
  });
  const marcaLider = filasMarca[0];
  const narrativaMarca = marcaLider
    ? `${marcaLider.etiqueta} lidera el periodo con ${fmtUnidades(marcaLider.unidadesActual)} unidades. El inventario se reporta al corte del ${fechaISO(ultimoCorte)}.`
    : "Sin ventas registradas en el periodo.";

  // --- Bloque 3: Top productos por marca -------------------------------
  const skusActual = await unidadesPor(account, periodoActual, {
    brand: "brand",
    sku: "sku",
    description: "description",
  });
  const skusAnterior = await unidadesPor(account, periodoAnterior, { sku: "sku" });
  const anteriorPorSku = new Map(skusAnterior.map((r) => [String(r.sku), r.units]));
  const invPorSku = await inventarioPorCampo(account, ultimoCorte, "sku");

  const porMarca = new Map<string, typeof skusActual>();
  for (const r of skusActual) {
    const lista = porMarca.get(String(r.brand)) ?? [];
    lista.push(r);
    porMarca.set(String(r.brand), lista);
  }
  const filasTop: FilaScorecard[] = [];
  for (const row of filasMarca.filter((f) => !f.esSubtotal)) {
    const lista = (porMarca.get(row.etiqueta) ?? [])
      .sort((a, b) => b.units - a.units)
      .slice(0, TOP_SKUS_POR_MARCA);
    if (lista.length === 0) continue;
    filasTop.push({ ...row, esSubtotal: true });
    for (const r of lista) {
      const sku = String(r.sku);
      const uAnterior = anteriorPorSku.get(sku) ?? null;
      const inv = invPorSku.get(sku) ?? null;
      const uMes = mesesConDatosActual > 0 ? r.units / mesesConDatosActual : null;
      filasTop.push({
        etiqueta: `${r.description || sku}`,
        unidadesAnterior: uAnterior,
        unidadesActual: r.units,
        inventario: inv,
        incVsAA: incVsAA(r.units, uAnterior),
        moh: moh(inv, uMes),
      });
    }
  }
  const narrativaTop = `Top ${TOP_SKUS_POR_MARCA} de productos por unidades dentro de cada marca, con su inventario al corte del ${fechaISO(ultimoCorte)}.`;

  // --- Bloque 4: Tiendas (top y bottom) --------------------------------
  // Sustituye al bloque "Formato" del scorecard de Walmart: el archivo de
  // San Pablo no trae columna de formato de tienda (§8.2).
  const tiendasActual = await unidadesPor(account, periodoActual, {
    storeCode: "storeCode",
    storeName: "storeName",
  });
  const tiendasAnterior = await unidadesPor(account, periodoAnterior, {
    storeCode: "storeCode",
  });
  const anteriorPorTienda = new Map(
    tiendasAnterior.map((r) => [String(r.storeCode), r.units])
  );
  const invPorTienda = await inventarioPorCampo(account, ultimoCorte, "storeCode");
  const ordenadas = tiendasActual.sort((a, b) => b.units - a.units);
  const top = ordenadas.slice(0, TOP_TIENDAS);
  const bottom = ordenadas.slice(-TOP_TIENDAS).reverse();

  const filaTienda = (r: (typeof ordenadas)[number]): FilaScorecard => {
    const codigo = String(r.storeCode);
    const uAnterior = anteriorPorTienda.get(codigo) ?? null;
    const inv = invPorTienda.get(codigo) ?? null;
    const uMes = mesesConDatosActual > 0 ? r.units / mesesConDatosActual : null;
    return {
      etiqueta: `${codigo} — ${String(r.storeName ?? "")}`,
      unidadesAnterior: uAnterior,
      unidadesActual: r.units,
      inventario: inv,
      incVsAA: incVsAA(r.units, uAnterior),
      moh: moh(inv, uMes),
    };
  };
  const filasTienda: FilaScorecard[] = [];
  if (top.length > 0) {
    filasTienda.push({
      etiqueta: `Top ${Math.min(TOP_TIENDAS, top.length)} tiendas`,
      unidadesAnterior: null,
      unidadesActual: null,
      inventario: null,
      incVsAA: null,
      moh: null,
      esSubtotal: true,
    });
    filasTienda.push(...top.map(filaTienda));
  }
  if (ordenadas.length > TOP_TIENDAS) {
    filasTienda.push({
      etiqueta: `Bottom ${Math.min(TOP_TIENDAS, bottom.length)} tiendas`,
      unidadesAnterior: null,
      unidadesActual: null,
      inventario: null,
      incVsAA: null,
      moh: null,
      esSubtotal: true,
    });
    filasTienda.push(...bottom.map(filaTienda));
  }
  const narrativaTienda = `${nf.format(ordenadas.length)} tiendas con venta registrada en el periodo. Se muestran las ${Math.min(TOP_TIENDAS, top.length)} de mayor y las ${Math.min(TOP_TIENDAS, bottom.length)} de menor desplazamiento.`;

  // --- Bloque 5: Fill rate ---------------------------------------------
  // Promedio ponderado por cantidad, cortado por negociador y por estatus
  // de OC, al último corte (§8.2).
  async function fillRatePor(field: string): Promise<FilaFillRate[]> {
    const res = await PurchaseOrderLine.aggregate([
      { $match: { account, cutoffDate: ultimoCorte } },
      {
        $group: {
          _id: `$${field}`,
          pedidas: { $sum: { $ifNull: ["$allocatedQty", 0] } },
          entregadas: { $sum: { $ifNull: ["$deliveredQty", 0] } },
        },
      },
      { $sort: { pedidas: -1 } },
    ]);
    return res.map((r) => ({
      etiqueta: String(r._id || "Sin dato"),
      pedidas: r.pedidas as number,
      entregadas: r.entregadas as number,
      fillRate: r.pedidas > 0 ? r.entregadas / r.pedidas : null,
    }));
  }
  const porNegociador = await fillRatePor("buyer");
  const porEstatus = await fillRatePor("poStatus");
  const totalPedidas = porNegociador.reduce((t, r) => t + r.pedidas, 0);
  const totalEntregadas = porNegociador.reduce((t, r) => t + r.entregadas, 0);
  const fillRateGlobal = totalPedidas > 0 ? totalEntregadas / totalPedidas : null;
  const filasFillRate: FilaFillRate[] = [
    { etiqueta: "Por negociador", pedidas: 0, entregadas: 0, fillRate: null, esSubtotal: true },
    ...porNegociador,
    { etiqueta: "Por estatus de OC", pedidas: 0, entregadas: 0, fillRate: null, esSubtotal: true },
    ...porEstatus,
    {
      etiqueta: "Total",
      pedidas: totalPedidas,
      entregadas: totalEntregadas,
      fillRate: fillRateGlobal,
      esSubtotal: true,
    },
  ];
  const narrativaFillRate =
    fillRateGlobal !== null
      ? `El fill rate ponderado del corte ${fechaISO(ultimoCorte)} es de ${fmtPct(fillRateGlobal - 0)} sobre ${fmtUnidades(totalPedidas)} unidades pedidas.`
      : "Sin órdenes de compra registradas en el último corte.";

  const sinHistorico = !hayAnterior;

  return {
    account,
    cuentaNombre,
    hasta: fechaISO(hasta),
    ultimoCorte: fechaISO(ultimoCorte),
    coverage: {
      desde: minFecha ? fechaISO(minFecha) : null,
      hasta: maxFecha ? fechaISO(maxFecha) : null,
      cortes: cortes.map(fechaISO),
      mesesCompletos,
      mesesParciales,
    },
    bloques: [
      { id: "mes", title: "Mes / Unidades", narrativa: narrativaMes, sinHistorico, filas: filasMes },
      { id: "brand", title: "Marca / Unidades", narrativa: narrativaMarca, sinHistorico, filas: filasMarca },
      { id: "top-productos", title: "Top productos / Unidades", narrativa: narrativaTop, sinHistorico, filas: filasTop },
      { id: "tiendas", title: "Tienda / Unidades", narrativa: narrativaTienda, sinHistorico, filas: filasTienda },
      { id: "fill-rate", title: "Fill rate", narrativa: narrativaFillRate, sinHistorico: false, filas: [], filasFillRate },
    ],
  };
}
