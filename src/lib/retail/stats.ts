import { connectDB } from "@/lib/db";
import { PurchaseOrderLine } from "@/models/PurchaseOrderLine";
import { DcStock } from "@/models/DcStock";
import { PharmacyStock } from "@/models/PharmacyStock";
import { SalesReport } from "@/models/SalesReport";
import { Upload } from "@/models/Upload";
import { DailySale } from "@/models/DailySale";
import { memoRetail } from "./cache";
import { RETAILERS, nombreRetailer } from "./retailers";
import { fechaISO } from "./normalize";

// Estadísticas para el overview del dashboard y la serie histórica (§10).

async function fillRateEnCorte(account: string, corte: Date): Promise<number | null> {
  const [r] = await PurchaseOrderLine.aggregate([
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
      },
    },
  ]);
  const [cedis] = await DcStock.aggregate([
    { $match: { account, cutoffDate: corte } },
    { $group: { _id: null, total: { $sum: { $ifNull: ["$realAvailabilityDC", 0] } } } },
  ]);
  return (farma?.total ?? 0) + (cedis?.total ?? 0);
}

// --- Overview del dashboard: venta mensual por retailer ----------------

/** Meses que abarca la gráfica general, contando el mes en curso. */
export const MESES_DASHBOARD = 12;

export interface VentasRetailer {
  id: string;
  nombre: string;
  /** Unidades vendidas dentro de la ventana. */
  unidades: number;
  /** Sobre el total de la ventana; null si no hubo venta en ningún retailer. */
  participacion: number | null;
  /** Meses de la ventana con venta registrada. */
  meses: number;
  /**
   * Reportes distintos guardados para este retailer, sin límite de ventana.
   *
   * Sólo cuentan los del analizador. La ingesta de /retail/cargar NO se suma
   * aquí: estampa `account: "san-pablo"` fijo en cada Upload (Uploader.tsx),
   * así que un reporte de Walmart subido por ahí aparecía como el último de
   * San Pablo. Un default no es una elección, y sin retailer elegido la carga
   * no se puede atribuir a nadie.
   */
  reportes: number;
  /** Fecha en que se guardó el último de esos reportes. */
  ultimaCarga: string | null;
  ultimoArchivo: string | null;
}

/** Un mes de la serie: `periodo` más una clave por retailer con sus unidades. */
export interface PuntoVentas {
  periodo: string; // "2026-07"
  [account: string]: string | number | null;
}

export interface ResumenDashboard {
  serie: PuntoVentas[];
  /** Todos los retailers, con o sin datos, ordenados por unidades. */
  retailers: VentasRetailer[];
  unidadesTotales: number;
  desde: string; // "2025-09"
  hasta: string;
  /** Meses de la ventana con venta; el divisor del promedio. */
  mesesConVenta: number;
  /** Unidades por mes con venta. Los meses vacíos no diluyen el promedio. */
  promedioMensual: number | null;
  ultimoPeriodo: string | null; // último mes CON venta
  periodoPrevio: string | null; // el mes contra el que se compara
  unidadesUltimoPeriodo: number;
  /** Variación del último mes con venta contra el anterior; null si no hay base. */
  variacionUltimoPeriodo: number | null;
}

interface VentaMes {
  _id: { account: string; periodo: string };
  units: number;
}

interface UltimaCarga {
  _id: string;
  fecha: Date | null;
  archivo: string | null;
  reportes: number;
}

/** "2026-07" del mes de una fecha, en UTC como el resto de retail. */
function claveMes(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

// La venta vive en dos colecciones porque llega por dos caminos: DailySale es
// el flujo de ingesta por hojas fijas (San Pablo) y SalesReport el del
// analizador (Walmart y lo que se sume después). Las dos guardan unidades
// —`units` y `posQty`—, así que la serie las suma en el mismo eje en vez de
// mostrar dos gráficas que nadie puede comparar.
//
// La ingesta sí cuenta para la VENTA aunque no cuente para los reportes (ver
// `VentasRetailer.reportes`): una fila de DailySale existe sólo si el archivo
// calzó con las hojas fijas de San Pablo, así que la cuenta está implícita en
// el formato. Un Upload, en cambio, se registra antes de parsear nada.
function agrupacionMensual(campoUnidades: string) {
  return {
    _id: {
      account: "$account",
      periodo: { $dateToString: { format: "%Y-%m", date: "$date" } },
    },
    units: { $sum: { $ifNull: [campoUnidades, 0] } },
  };
}


export async function resumenDashboard(): Promise<ResumenDashboard> {
  await connectDB();

  const ahora = new Date();
  const inicio = new Date(
    Date.UTC(ahora.getUTCFullYear(), ahora.getUTCMonth() - (MESES_DASHBOARD - 1), 1)
  );
  const meses: string[] = [];
  for (let i = 0; i < MESES_DASHBOARD; i++) {
    meses.push(claveMes(new Date(Date.UTC(inicio.getUTCFullYear(), inicio.getUTCMonth() + i, 1))));
  }

  const [ventasAnalisis, ventasIngesta, cargasAnalisis] = await Promise.all([
    SalesReport.aggregate<VentaMes>([
      { $match: { date: { $gte: inicio } } },
      { $group: agrupacionMensual("$posQty") },
    ]),
    DailySale.aggregate<VentaMes>([
      { $match: { date: { $gte: inicio } } },
      { $group: agrupacionMensual("$units") },
    ]),
    // El analizador guarda una fila por artículo × día, así que los reportes se
    // cuentan por `sourceFile` distinto y no por documento. Volver a subir el
    // mismo archivo lo actualiza (upsert por la clave natural), y con $addToSet
    // sigue contando como un reporte, que es lo que se quiere ver.
    SalesReport.aggregate<UltimaCarga>([
      { $sort: { importedAt: -1 } },
      {
        $group: {
          _id: "$account",
          fecha: { $first: "$importedAt" },
          archivo: { $first: "$sourceFile" },
          archivos: { $addToSet: "$sourceFile" },
        },
      },
      { $project: { fecha: 1, archivo: 1, reportes: { $size: "$archivos" } } },
    ]),
  ]);

  const ventas = new Map<string, Map<string, number>>();
  for (const v of [...ventasAnalisis, ...ventasIngesta]) {
    const porMes = ventas.get(v._id.account) ?? new Map<string, number>();
    porMes.set(v._id.periodo, (porMes.get(v._id.periodo) ?? 0) + v.units);
    ventas.set(v._id.account, porMes);
  }

  const cargas = new Map(cargasAnalisis.map((c) => [c._id, c]));

  // Los cuatro retailers conocidos siempre salen, tengan datos o no: el panel
  // es la lista completa. Una cuenta desconocida con venta se suma al final en
  // vez de desaparecer, igual que hace nombreRetailer con los ids viejos.
  const ids = [
    ...RETAILERS.map((r) => r.id),
    ...[...ventas.keys(), ...cargas.keys()].filter(
      (id) => !RETAILERS.some((r) => r.id === id)
    ),
  ];
  const cuentas = [...new Set(ids)];

  const serie: PuntoVentas[] = meses.map((periodo) => {
    const punto: PuntoVentas = { periodo };
    for (const id of cuentas) {
      // null y no 0: un mes sin reporte no es un mes sin venta, y la línea
      // debe cortarse ahí en vez de caer al suelo.
      punto[id] = ventas.get(id)?.get(periodo) ?? null;
    }
    return punto;
  });

  const unidadesPorCuenta = new Map(
    cuentas.map((id) => {
      const porMes = ventas.get(id);
      const total = meses.reduce((t, m) => t + (porMes?.get(m) ?? 0), 0);
      return [id, total];
    })
  );
  const unidadesTotales = [...unidadesPorCuenta.values()].reduce((t, u) => t + u, 0);

  const retailers: VentasRetailer[] = cuentas
    .map((id) => {
      const porMes = ventas.get(id);
      const unidades = unidadesPorCuenta.get(id) ?? 0;
      const carga = cargas.get(id);
      return {
        id,
        nombre: nombreRetailer(id),
        unidades,
        participacion: unidadesTotales > 0 ? unidades / unidadesTotales : null,
        meses: meses.filter((m) => (porMes?.get(m) ?? 0) > 0).length,
        reportes: carga?.reportes ?? 0,
        ultimaCarga: carga?.fecha ? new Date(carga.fecha).toISOString() : null,
        ultimoArchivo: carga?.archivo ?? null,
      };
    })
    .sort((a, b) => b.unidades - a.unidades || a.nombre.localeCompare(b.nombre));

  // El "último mes" es el último CON venta, no el mes en curso: a mitad de mes,
  // o antes de que llegue el reporte, el corriente está vacío y compararlo
  // contra el anterior daría una caída del 100% que no ocurrió.
  const unidadesMes = meses.map((m) =>
    cuentas.reduce((t, id) => t + (ventas.get(id)?.get(m) ?? 0), 0)
  );
  let iUltimo = -1;
  for (let i = meses.length - 1; i >= 0; i--) {
    if (unidadesMes[i] > 0) {
      iUltimo = i;
      break;
    }
  }
  const previo = iUltimo > 0 ? unidadesMes[iUltimo - 1] : 0;
  const mesesConVenta = unidadesMes.filter((u) => u > 0).length;

  return {
    serie,
    retailers,
    unidadesTotales,
    desde: meses[0],
    hasta: meses[meses.length - 1],
    mesesConVenta,
    promedioMensual: mesesConVenta > 0 ? unidadesTotales / mesesConVenta : null,
    ultimoPeriodo: iUltimo >= 0 ? meses[iUltimo] : null,
    periodoPrevio: iUltimo > 0 && previo > 0 ? meses[iUltimo - 1] : null,
    unidadesUltimoPeriodo: iUltimo >= 0 ? unidadesMes[iUltimo] : 0,
    variacionUltimoPeriodo:
      iUltimo >= 0 && previo > 0 ? (unidadesMes[iUltimo] - previo) / previo : null,
  };
}

// --- Lista de retailers (/retail) --------------------------------------

export interface DetalleRetailer {
  id: string;
  nombre: string;
  /** Importe vendido en todos sus reportes. */
  importe: number;
  unidades: number;
  /** Artículos distintos vistos en el histórico del retailer. */
  articulos: number;
  reportes: number;
  /** Sobre el importe de todos los retailers; null si nadie vendió. */
  participacion: number | null;
  desde: string | null;
  hasta: string | null;
  ultimoReporte: string | null;
  ultimoArchivo: string | null;
}

interface AgregadoCuenta {
  _id: string;
  importe: number;
  unidades: number;
  articulos: string[];
  archivos: string[];
  desde: Date | null;
  hasta: Date | null;
  ultimoReporte: Date | null;
}

/**
 * Una fila por retailer para la portada del módulo.
 *
 * Sin ventana de tiempo, a diferencia de `resumenDashboard`: la portada habla
 * de todo lo que se ha guardado del retailer, no de los últimos doce meses.
 * Sale sólo de SalesReport —la colección del analizador, la única con datos—
 * y los cuatro de RETAILERS aparecen siempre, tengan reportes o no.
 */
/**
 * Ficha de cada retailer para la portada de /retail y para la cabecera de
 * /retail/[retailer].
 *
 * Va por `memoRetail` porque es lo primero que espera la navegación a la ficha:
 * el $group con dos $addToSet sobre la colección entera se midió en 2.9 s, 1.5 s
 * y 0.2 s en tres corridas seguidas, y hasta que contesta el navegador ni
 * siquiera ha empezado a pedir los datos de las gráficas. Es el mismo dato para
 * todo el mundo y sólo cambia al guardar o borrar un reporte, que es cuando se
 * invalida.
 */
export async function detalleRetailers(): Promise<DetalleRetailer[]> {
  return memoRetail("detalleRetailers", calcularDetalleRetailers);
}

async function calcularDetalleRetailers(): Promise<DetalleRetailer[]> {
  await connectDB();

  const filas = await SalesReport.aggregate<AgregadoCuenta>([
    {
      $group: {
        _id: "$account",
        importe: { $sum: { $ifNull: ["$posSales", 0] } },
        unidades: { $sum: { $ifNull: ["$posQty", 0] } },
        articulos: { $addToSet: "$itemNbr" },
        archivos: { $addToSet: "$sourceFile" },
        desde: { $min: "$date" },
        hasta: { $max: "$date" },
        ultimoReporte: { $max: "$importedAt" },
      },
    },
  ]);

  const porCuenta = new Map(filas.map((f) => [f._id, f]));
  const total = filas.reduce((t, f) => t + f.importe, 0);

  // El último archivo no sale del $group: `$max` sobre importedAt no arrastra
  // el sourceFile de esa misma fila. Se resuelve con un findOne por cuenta con
  // datos, que el índice { importedAt: -1 } contesta de inmediato.
  const ultimos = await Promise.all(
    [...porCuenta.keys()].map((account) =>
      SalesReport.findOne({ account })
        .sort({ importedAt: -1 })
        .select({ sourceFile: 1 })
        .lean()
        .then((d) => [account, d?.sourceFile ?? null] as const)
    )
  );
  const ultimoArchivo = new Map(ultimos);

  const ids = [
    ...RETAILERS.map((r) => r.id),
    ...[...porCuenta.keys()].filter((id) => !RETAILERS.some((r) => r.id === id)),
  ];

  return [...new Set(ids)]
    .map((id) => {
      const f = porCuenta.get(id);
      return {
        id,
        nombre: nombreRetailer(id),
        importe: f?.importe ?? 0,
        unidades: f?.unidades ?? 0,
        articulos: f?.articulos.length ?? 0,
        reportes: f?.archivos.length ?? 0,
        participacion: total > 0 ? (f?.importe ?? 0) / total : null,
        desde: f?.desde ? fechaISO(new Date(f.desde)) : null,
        hasta: f?.hasta ? fechaISO(new Date(f.hasta)) : null,
        ultimoReporte: f?.ultimoReporte ? new Date(f.ultimoReporte).toISOString() : null,
        ultimoArchivo: ultimoArchivo.get(id) ?? null,
      };
    })
    .sort((a, b) => b.importe - a.importe || a.nombre.localeCompare(b.nombre));
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

  const semanas = await DailySale.aggregate([
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
    const [venta30] = await DailySale.aggregate([
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
