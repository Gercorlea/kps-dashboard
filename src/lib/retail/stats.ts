import { connectDB } from "@/lib/db";
import { ReportImport } from "@/models/ReportImport";
import { SalesReport } from "@/models/SalesReport";
import { DailySale } from "@/models/DailySale";
import { RETAILERS, nombreRetailer } from "./retailers";
import { fechaISO } from "./normalize";

// Estadísticas para el overview del dashboard y la lista de retailers.

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
    // Un documento por reporte cargado, así que los reportes se cuentan con un
    // $sum y no reuniendo los `sourceFile` distintos de las ~15 mil filas de
    // cada cuenta. El $sort de arriba es lo que le da sentido al $first: el
    // reporte tocado más recientemente es el primero de su grupo.
    ReportImport.aggregate<UltimaCarga>([
      { $sort: { lastWriteAt: -1 } },
      {
        $group: {
          _id: "$account",
          fecha: { $first: "$lastWriteAt" },
          archivo: { $first: "$sourceFile" },
          reportes: { $sum: 1 },
        },
      },
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
  /** Productos distintos vistos en el histórico del retailer. */
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
  desde: Date | null;
  hasta: Date | null;
}

/**
 * Ficha de cada retailer para la portada de /retail y para la cabecera de
 * /retail/[retailer].
 *
 * Sin ventana de tiempo, a diferencia de `resumenDashboard`: la portada habla
 * de todo lo que se ha guardado del retailer, no de los últimos doce meses.
 * Sale sólo de SalesReport —la colección del analizador, la única con datos—
 * y los cuatro de RETAILERS aparecen siempre, tengan reportes o no.
 *
 * Se paga entera en cada visita, y es lo primero que espera la navegación a la
 * ficha: el $group con dos $addToSet recorre la colección completa y se midió
 * en 2.9 s, 1.5 s y 0.2 s en tres corridas seguidas. Hubo aquí una memoria de
 * proceso que escondía ese coste, pero invalidarla sólo alcanzaba a la instancia
 * que atendía la escritura: en Vercel el POST cae en una lambda y el render en
 * otra, así que la portada seguía contando reportes ya borrados y no veía los
 * recién subidos. Antes de volver a cachear esto hay que medirlo de nuevo.
 */
export async function detalleRetailers(): Promise<DetalleRetailer[]> {
  await connectDB();

  const filas = await SalesReport.aggregate<AgregadoCuenta>([
    {
      $group: {
        _id: "$account",
        importe: { $sum: { $ifNull: ["$posSales", 0] } },
        unidades: { $sum: { $ifNull: ["$posQty", 0] } },
        articulos: { $addToSet: "$itemNbr" },
        desde: { $min: "$date" },
        hasta: { $max: "$date" },
      },
    },
  ]);

  const porCuenta = new Map(filas.map((f) => [f._id, f]));
  const total = filas.reduce((t, f) => t + f.importe, 0);

  // Cuántos reportes tiene cada cuenta, cuál fue el último y cuándo. Sale de la
  // colección de cargas —una decena de documentos— y no de las filas: antes eran
  // un $addToSet de `sourceFile` sobre el histórico entero MÁS un findOne por
  // cuenta, porque `$max` sobre importedAt no arrastra el archivo de esa misma
  // fila. Un solo $group contesta las tres cosas.
  const cargas = await ReportImport.aggregate<UltimaCarga>([
    { $sort: { lastWriteAt: -1 } },
    {
      $group: {
        _id: "$account",
        fecha: { $first: "$lastWriteAt" },
        archivo: { $first: "$sourceFile" },
        reportes: { $sum: 1 },
      },
    },
  ]);
  const porCarga = new Map(cargas.map((c) => [c._id, c]));

  // Las dos fuentes aportan cuentas: un reporte recién borrado deja filas sin
  // carga, y una carga interrumpida deja carga sin filas. Ninguna de las dos
  // debe hacer desaparecer al retailer de la portada.
  const ids = [
    ...RETAILERS.map((r) => r.id),
    ...[...porCuenta.keys(), ...porCarga.keys()].filter(
      (id) => !RETAILERS.some((r) => r.id === id)
    ),
  ];

  return [...new Set(ids)]
    .map((id) => {
      const f = porCuenta.get(id);
      const carga = porCarga.get(id);
      return {
        id,
        nombre: nombreRetailer(id),
        importe: f?.importe ?? 0,
        unidades: f?.unidades ?? 0,
        articulos: f?.articulos.length ?? 0,
        reportes: carga?.reportes ?? 0,
        participacion: total > 0 ? (f?.importe ?? 0) / total : null,
        desde: f?.desde ? fechaISO(new Date(f.desde)) : null,
        hasta: f?.hasta ? fechaISO(new Date(f.hasta)) : null,
        ultimoReporte: carga?.fecha ? new Date(carga.fecha).toISOString() : null,
        ultimoArchivo: carga?.archivo ?? null,
      };
    })
    .sort((a, b) => ordenRetailer(a.id) - ordenRetailer(b.id) || a.nombre.localeCompare(b.nombre));
}

const ORDEN_RETAILERS = ["walmart", "san-pablo", "farmacias-del-ahorro", "heb"];

function ordenRetailer(id: string): number {
  const i = ORDEN_RETAILERS.indexOf(id);
  return i === -1 ? ORDEN_RETAILERS.length : i;
}

// --- Ventas netas mensuales (gráfica de /dashboard) --------------------

/** Un mes CON reporte. Los meses sin reporte no existen en la serie. */
export interface PuntoVentasNetas {
  periodo: string; // "2026-03"
  /** Suma de los retailers que SÍ reportaron ese mes. Nunca null aquí. */
  total: number;
  /** Importe por retailer; la clave FALTA en el que no reportó. */
  porRetailer: Record<string, number>;
}

export interface VentasNetas {
  /** Todo el histórico, cronológico, sólo meses con reporte. */
  serie: PuntoVentasNetas[];
  /** Años seleccionables, descendente. Siempre incluye `anioActual`. */
  anios: number[];
  /** Año en curso en UTC, resuelto en el servidor: el filtro por omisión. */
  anioActual: number;
  /** Las cuentas cuyo importe se suma, en el orden de RETAILERS. */
  retailers: { id: string; nombre: string }[];
}

interface VentaMesMoneda {
  _id: { account: string; periodo: string };
  importe: number;
}

/**
 * Venta neta mensual sumada de todos los retailers, todo el histórico.
 *
 * Sale sólo de SalesReport y no de la unión de dos colecciones que hace
 * `resumenDashboard`: el dinero vive únicamente aquí. DailySale —la ingesta por
 * hojas fijas de San Pablo— guarda `units` y ningún campo de importe, así que no
 * hay nada suyo que sumar en un eje de pesos.
 *
 * Devuelve el histórico COMPLETO y el filtro por año se aplica en el cliente
 * (ver VentasNetasChart). Un `?anio=` en la URL volvería a ejecutar el render de
 * /dashboard, y con él `detalleRetailers()` —medido en 2.9 s sin caché—, así que
 * cada clic en un año pagaría ese scan y repintaría el ranking, que no tiene
 * nada que ver con el año. La serie entera son ~30 meses: unos 2 KB. Es el mismo
 * criterio, ya medido, del bundle de /api/retail/analisis/resumen.
 *
 * Cero y null NO son lo mismo, y de aquí sale la distinción que respeta la
 * gráfica: un 0 viene de filas que reportaron cero —eso lo cubre el $ifNull— y
 * la ausencia viene de que no hay bucket en el $group. Un mes cuyas filas suman
 * genuinamente $0 es un dato y debe pintarse como 0; un mes sin reporte corta la
 * línea. Por eso `total` es `number` y no `number | null`: un mes que está en la
 * serie tiene filas, y la nulabilidad aparece sólo al armar las doce casillas
 * del año en el cliente.
 */
export async function ventasNetasMensuales(): Promise<VentasNetas> {
  await connectDB();

  // Sin $match ni $sort: son ~120 filas (cuentas × meses) y ordenarlas en JS
  // por texto es más barato que pedirle a Mongo otra etapa. Sin $addToSet, que
  // es lo que hace lenta a `detalleRetailers`, así que esta agregación se
  // esconde entera bajo la latencia de aquella cuando corren en paralelo.
  const filas = await SalesReport.aggregate<VentaMesMoneda>([
    {
      $group: {
        _id: {
          account: "$account",
          // Sin `timezone`, $dateToString formatea en UTC, y `date` se guarda a
          // medianoche UTC: la clave es la misma que construye claveMes.
          periodo: { $dateToString: { format: "%Y-%m", date: "$date" } },
        },
        importe: { $sum: { $ifNull: ["$posSales", 0] } },
      },
    },
  ]);

  const porPeriodo = new Map<string, Record<string, number>>();
  for (const f of filas) {
    const mes = porPeriodo.get(f._id.periodo) ?? {};
    mes[f._id.account] = (mes[f._id.account] ?? 0) + f.importe;
    porPeriodo.set(f._id.periodo, mes);
  }

  // Los periodos ordenan como texto porque son "YYYY-MM": nada de construir
  // Date sólo para compararlos, que es de donde salen los corrimientos de zona.
  const serie: PuntoVentasNetas[] = [...porPeriodo.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([periodo, porRetailer]) => ({
      periodo,
      total: Object.values(porRetailer).reduce((t, v) => t + v, 0),
      porRetailer,
    }));

  // Una cuenta desconocida con dinero TIENE que entrar en la suma: si no, unas
  // "ventas netas de todos los retailers" reportarían de menos sin decirlo.
  // colorRetailer ya le da el color de sobra (--viz-6) para el tooltip.
  const ids = [
    ...RETAILERS.map((r) => r.id),
    ...[...new Set(filas.map((f) => f._id.account))].filter(
      (id) => !RETAILERS.some((r) => r.id === id)
    ),
  ];

  // El año en curso se resuelve aquí y no en el navegador: allá saldría en la
  // zona LOCAL mientras que cada clave de mes se armó en UTC, y un new Date()
  // durante el render arriesga un desajuste de hidratación.
  const anioActual = new Date().getUTCFullYear();

  // El año en curso siempre es seleccionable, aunque no tenga un solo reporte:
  // "todavía no hay nada de 2026" es información, y caer por omisión al año
  // anterior dejaría leer sus cifras como las de este.
  const anios = [...new Set([anioActual, ...serie.map((p) => Number(p.periodo.slice(0, 4)))])].sort(
    (a, b) => b - a
  );

  return {
    serie,
    anios,
    anioActual,
    retailers: ids.map((id) => ({ id, nombre: nombreRetailer(id) })),
  };
}