// Crecimiento para KPS AI: un periodo contra otro, por grupo, con el % ya
// calculado. Existe por la misma razón que los agregados y el pronóstico: el
// modelo no debe restar ni dividir cifras del negocio.
//
// Una sola pasada por Mongo: se filtra la unión de los dos periodos y cada
// documento suma al periodo que le toca con $cond. Así "crecimiento de los
// productos" cuesta lo mismo que un ranking.
import { connectDB } from "@/lib/db";
import { asegurarFacturasFrescas } from "@/lib/sap/sincronizar-facturas";
import {
  campoDe,
  campoPermitido,
  construirFiltro,
  fechaDe,
  metricaSumable,
  modeloDe,
  type ColeccionRetail,
  type ConsultaRetail,
} from "./consultas-ia";

export interface Periodo {
  desde: string; // AAAA-MM-DD inclusive
  hasta: string; // AAAA-MM-DD inclusive
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const DIA_MS = 86_400_000;

function fechaUTC(iso: string): Date {
  if (!ISO.test(iso)) throw new Error(`Fecha inválida: "${iso}" (usa AAAA-MM-DD)`);
  const d = new Date(`${iso}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) throw new Error(`Fecha inválida: "${iso}"`);
  return d;
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Valida el periodo y devuelve sus fechas. */
export function parsearPeriodo(p: Periodo): { desde: Date; hasta: Date } {
  const desde = fechaUTC(p.desde);
  const hasta = fechaUTC(p.hasta);
  if (hasta < desde) throw new Error(`El periodo termina antes de empezar (${p.desde} → ${p.hasta}).`);
  return { desde, hasta };
}

export type ModoComparacion = "anterior" | "anioAnterior";

/**
 * El periodo con el que se compara: el inmediatamente anterior de la misma
 * duración, o el mismo tramo del año pasado.
 */
export function periodoAnterior(p: Periodo, modo: ModoComparacion): Periodo {
  const { desde, hasta } = parsearPeriodo(p);
  if (modo === "anioAnterior") {
    const d = new Date(desde);
    const h = new Date(hasta);
    d.setUTCFullYear(d.getUTCFullYear() - 1);
    h.setUTCFullYear(h.getUTCFullYear() - 1);
    return { desde: iso(d), hasta: iso(h) };
  }
  const duracion = Math.round((hasta.getTime() - desde.getTime()) / DIA_MS); // días - 1
  const hastaAnt = new Date(desde.getTime() - DIA_MS);
  const desdeAnt = new Date(hastaAnt.getTime() - duracion * DIA_MS);
  return { desde: iso(desdeAnt), hasta: iso(hastaAnt) };
}

export interface FilaCrecimiento {
  grupo: string | null;
  actual: number;
  anterior: number;
  diferencia: number;
  /** null cuando el periodo anterior es 0: no hay base para un porcentaje. */
  crecimientoPct: number | null;
}

export type OrdenCrecimiento = "actual" | "crecimiento" | "diferencia";

function redondear(v: number): number {
  return Math.round(v * 100) / 100;
}

/** Junta los dos periodos por grupo y calcula diferencia y %. Pura. */
export function compararGrupos(
  actual: Map<string | null, number>,
  anterior: Map<string | null, number>,
  opciones: { ordenarPor?: OrdenCrecimiento; limite?: number } = {}
): { filas: FilaCrecimiento[]; totales: FilaCrecimiento; grupos: number } {
  const claves = new Set<string | null>([...actual.keys(), ...anterior.keys()]);
  const filas: FilaCrecimiento[] = [];
  let sumaActual = 0;
  let sumaAnterior = 0;
  for (const g of claves) {
    const a = actual.get(g) ?? 0;
    const b = anterior.get(g) ?? 0;
    sumaActual += a;
    sumaAnterior += b;
    filas.push({
      grupo: g,
      actual: redondear(a),
      anterior: redondear(b),
      diferencia: redondear(a - b),
      crecimientoPct: b === 0 ? null : redondear(((a - b) / b) * 100),
    });
  }
  const orden = opciones.ordenarPor ?? "actual";
  filas.sort((x, y) => {
    if (orden === "crecimiento") {
      // Los sin base (null) al final: un "infinito" no es un ranking.
      if (x.crecimientoPct === null) return y.crecimientoPct === null ? y.actual - x.actual : 1;
      if (y.crecimientoPct === null) return -1;
      return y.crecimientoPct - x.crecimientoPct;
    }
    return orden === "diferencia" ? y.diferencia - x.diferencia : y.actual - x.actual;
  });
  const limite = Math.min(Math.max(opciones.limite ?? 20, 1), 50);
  return {
    filas: filas.slice(0, limite),
    grupos: filas.length,
    totales: {
      grupo: null,
      actual: redondear(sumaActual),
      anterior: redondear(sumaAnterior),
      diferencia: redondear(sumaActual - sumaAnterior),
      crecimientoPct: sumaAnterior === 0 ? null : redondear(((sumaActual - sumaAnterior) / sumaAnterior) * 100),
    },
  };
}

export interface ConsultaCrecimiento {
  coleccion: ColeccionRetail;
  filtros?: ConsultaRetail["filtros"];
  metrica: string;
  periodo: Periodo;
  /** Con qué se compara: "anterior" (defecto), "anioAnterior" o un periodo explícito. */
  comparadoCon?: ModoComparacion | Periodo;
  agruparPor?: string;
  ordenarPor?: OrdenCrecimiento;
  limite?: number;
}

export interface ResultadoCrecimiento {
  metrica: string;
  etiqueta: string;
  periodo: Periodo;
  periodoAnterior: Periodo;
  agruparPor: string | null;
  grupos: number;
  filas: FilaCrecimiento[];
  totales: FilaCrecimiento;
  camposIgnorados?: string[];
}

export async function compararPeriodosRetail(consulta: ConsultaCrecimiento): Promise<ResultadoCrecimiento> {
  const fecha = fechaDe(consulta.coleccion);
  if (!fecha) throw new Error(`La colección ${consulta.coleccion} no tiene fechas: no se puede comparar.`);
  const metrica = campoDe(consulta.coleccion, consulta.metrica);
  if (!metrica || !metricaSumable(consulta.coleccion, consulta.metrica)) {
    throw new Error(`"${consulta.metrica}" no es una métrica sumable de ${consulta.coleccion}.`);
  }
  if (consulta.agruparPor && !campoPermitido(consulta.coleccion, consulta.agruparPor)) {
    throw new Error(`"${consulta.agruparPor}" no es un campo por el que se pueda agrupar en ${consulta.coleccion}.`);
  }
  const agruparPor = consulta.agruparPor ?? null;

  const actual = parsearPeriodo(consulta.periodo);
  const anteriorDef =
    typeof consulta.comparadoCon === "object"
      ? consulta.comparadoCon
      : periodoAnterior(consulta.periodo, consulta.comparadoCon ?? "anterior");
  const anterior = parsearPeriodo(anteriorDef);

  await connectDB();
  if (consulta.coleccion === "sapSales" || consulta.coleccion === "sapSalesLotes") {
    await asegurarFacturasFrescas();
  }
  const { filtro, ignorados } = construirFiltro(consulta);
  // El filtro del usuario no debe pisar el rango de fechas de la comparación.
  delete filtro[fecha];

  const enRango = (r: { desde: Date; hasta: Date }) => ({
    $and: [{ $gte: [`$${fecha}`, r.desde] }, { $lte: [`$${fecha}`, r.hasta] }],
  });
  const desdeMin = new Date(Math.min(actual.desde.getTime(), anterior.desde.getTime()));
  const hastaMax = new Date(Math.max(actual.hasta.getTime(), anterior.hasta.getTime()));

  const filas = await modeloDe(consulta.coleccion).aggregate<{
    _id: unknown;
    actual: number;
    anterior: number;
  }>([
    { $match: { ...filtro, [fecha]: { $gte: desdeMin, $lte: hastaMax } } },
    {
      $group: {
        _id: agruparPor ? `$${agruparPor}` : null,
        actual: { $sum: { $cond: [enRango(actual), `$${consulta.metrica}`, 0] } },
        anterior: { $sum: { $cond: [enRango(anterior), `$${consulta.metrica}`, 0] } },
      },
    },
  ]);

  const mapaActual = new Map<string | null, number>();
  const mapaAnterior = new Map<string | null, number>();
  for (const f of filas) {
    const g = f._id === null || f._id === undefined ? null : String(f._id);
    mapaActual.set(g, f.actual);
    mapaAnterior.set(g, f.anterior);
  }
  const r = compararGrupos(mapaActual, mapaAnterior, {
    ordenarPor: consulta.ordenarPor,
    limite: consulta.limite,
  });

  return {
    metrica: consulta.metrica,
    etiqueta: metrica.etiqueta,
    periodo: { desde: iso(actual.desde), hasta: iso(actual.hasta) },
    periodoAnterior: { desde: iso(anterior.desde), hasta: iso(anterior.hasta) },
    agruparPor,
    ...r,
    ...(ignorados.length ? { camposIgnorados: ignorados } : {}),
  };
}
