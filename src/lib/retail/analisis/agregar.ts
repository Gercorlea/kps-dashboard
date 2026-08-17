// Agregaciones sobre las filas crudas. Módulo puro y sin imports de runtime.
//
// Todo recorre las filas con un solo `for` y un solo Map: nada de cadenas
// .map().filter().reduce() sobre 15k filas.

import { valorFecha, valorNumerico } from "./inferir-tipos";
import type {
  Agregacion,
  FilaCruda,
  Granularidad,
  Kpis,
  MetaColumna,
  PuntoAgrupado,
  PuntoSerie,
} from "./tipos";

export const SIN_VALOR = "(sin valor)";
export const OTROS = "Otros";

const MAX_BUCKETS = 2000;

/**
 * Par (suma, conteo) de un grupo. Se exporta porque el histórico lo arma desde
 * un `$group` de Mongo y lo pasa por los mismos plegados que las filas del
 * navegador: guardar los dos acumuladores —y no sólo el valor resuelto— es lo
 * que permite que el bucket "Otros" sea correcto también en promedio.
 */
export interface Acumulador {
  suma: number;
  conteo: number;
}

export function resolver(acc: Acumulador, agregacion: Agregacion): number {
  if (agregacion === "conteo") return acc.conteo;
  if (agregacion === "promedio") return acc.conteo === 0 ? 0 : acc.suma / acc.conteo;
  return acc.suma;
}

function dosDigitos(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * Clave textual de un valor de dimensión. Las fechas se normalizan a
 * YYYY-MM-DD con getters LOCALES para no correrse un día por zona horaria.
 */
function claveDimension(v: unknown): string {
  if (v === null || v === undefined) return SIN_VALOR;
  if (v instanceof Date) {
    return `${v.getFullYear()}-${dosDigitos(v.getMonth() + 1)}-${dosDigitos(v.getDate())}`;
  }
  const s = String(v).trim();
  return s === "" ? SIN_VALOR : s;
}

/**
 * Bucket temporal. Con ceros a la izquierda, para que el orden alfabético de
 * las claves sea el orden cronológico.
 */
export function claveTemporal(d: Date, granularidad: Granularidad): string {
  const anio = d.getFullYear();
  if (granularidad === "anio") return String(anio);
  const mes = dosDigitos(d.getMonth() + 1);
  if (granularidad === "mes") return `${anio}-${mes}`;
  return `${anio}-${mes}-${dosDigitos(d.getDate())}`;
}

/**
 * Agrupa por dimensión, ordena descendente, toma topN y pliega el resto.
 *
 * `colMetrica === null` significa la métrica sintética "Cantidad de filas".
 */
export function agrupar(
  filas: FilaCruda[],
  colDimension: MetaColumna,
  colMetrica: MetaColumna | null,
  agregacion: Agregacion,
  topN: number
): PuntoAgrupado[] {
  const mapa = new Map<string, Acumulador>();
  const iDim = colDimension.indice;
  const iMet = colMetrica?.indice ?? -1;

  for (const fila of filas) {
    let valor = 1;
    if (colMetrica) {
      const n = valorNumerico(fila[iMet], colMetrica);
      // Una fila sin métrica legible no aporta ni a la suma ni al promedio.
      if (n === null) continue;
      valor = n;
    }

    // Las filas de subtotal / "TOTAL GENERAL" que traen los exports suelen
    // venir con la dimensión vacía. Se agrupan en (sin valor), visibles en la
    // gráfica, en vez de fusionarse en silencio o descartarse adivinando.
    const clave = claveDimension(fila[iDim]);
    const acc = mapa.get(clave);
    if (acc) {
      acc.suma += valor;
      acc.conteo++;
    } else {
      mapa.set(clave, { suma: valor, conteo: 1 });
    }
  }

  return plegarTopN(mapa, agregacion, topN);
}

/**
 * Un grupo tal como lo devuelve el `$group` del histórico: la clave ya
 * normalizada y, alineados al arreglo `metricas` de la respuesta, la suma de
 * cada métrica y cuántas filas la tenían legible.
 */
export interface GrupoAcumulado {
  clave: string;
  /** Filas del grupo, con métrica legible o sin ella. */
  conteo: number;
  suma: number[];
  n: number[];
}

/**
 * Grupos del servidor → el mapa que comen `plegarTopN` y `rellenarSerie`.
 *
 * Es la pieza que hace instantáneo cambiar de métrica en el histórico: el
 * servidor manda los acumuladores de TODAS las métricas de una vez y aquí se
 * elige una sin volver a preguntar. `metrica` en null es la métrica sintética
 * "Cantidad de filas", donde `agrupar` cuenta 1 por fila — de ahí que la suma
 * sea el propio conteo.
 */
export function acumuladoresDeGrupos(
  grupos: GrupoAcumulado[],
  metricas: string[],
  metrica: string | null
): Map<string, Acumulador> {
  const i = metrica ? metricas.indexOf(metrica) : -1;
  const mapa = new Map<string, Acumulador>();
  for (const g of grupos) {
    // Una métrica que el servidor no mandó se trata como la sintética, en vez
    // de producir NaN silenciosos por indexar fuera del arreglo.
    const acc: Acumulador =
      i < 0
        ? { suma: g.conteo, conteo: g.conteo }
        : { suma: g.suma[i] ?? 0, conteo: g.n[i] ?? 0 };
    const previo = mapa.get(g.clave);
    if (previo) {
      previo.suma += acc.suma;
      previo.conteo += acc.conteo;
    } else {
      mapa.set(g.clave, acc);
    }
  }
  return mapa;
}

/**
 * Reagrupa una serie a un bucket más grueso recortando la clave.
 *
 * Las claves son "YYYY-MM-DD" / "YYYY-MM" / "YYYY", así que mes → año es
 * recortar a 4 caracteres y día → mes a 7. Se hace sobre el texto y no sobre
 * fechas justamente para no reintroducir un corrimiento de zona horaria.
 */
export function reagruparSerie(
  mapa: Map<string, Acumulador>,
  largo: number
): Map<string, Acumulador> {
  const salida = new Map<string, Acumulador>();
  for (const [clave, acc] of mapa) {
    const corta = clave.slice(0, largo);
    const previo = salida.get(corta);
    if (previo) {
      previo.suma += acc.suma;
      previo.conteo += acc.conteo;
    } else {
      salida.set(corta, { suma: acc.suma, conteo: acc.conteo });
    }
  }
  return salida;
}

/**
 * Ordena los grupos, deja los `topN` primeros y pliega el resto en OTROS.
 *
 * Separado de `agrupar` porque el histórico llega hasta aquí por otro camino:
 * sus acumuladores salen de un `$group` de Mongo, no de recorrer filas. Con el
 * plegado compartido las dos vistas producen el mismo `PuntoAgrupado[]`, que es
 * lo que evita que se desincronicen.
 */
export function plegarTopN(
  mapa: Map<string, Acumulador>,
  agregacion: Agregacion,
  topN: number
): PuntoAgrupado[] {
  const puntos: PuntoAgrupado[] = [];
  for (const [clave, acc] of mapa) {
    puntos.push({
      clave,
      valor: resolver(acc, agregacion),
      suma: acc.suma,
      conteo: acc.conteo,
    });
  }
  puntos.sort((a, b) => b.valor - a.valor);

  if (puntos.length <= topN) return puntos;

  const visibles = puntos.slice(0, topN);
  const resto = puntos.slice(topN);
  const acumulado: Acumulador = { suma: 0, conteo: 0 };
  for (const p of resto) {
    acumulado.suma += p.suma;
    acumulado.conteo += p.conteo;
  }

  visibles.push({
    clave: OTROS,
    // Con promedio esto es Σsuma/Σconteo, no el promedio de los promedios
    // descartados: el bucket guarda ambos acumuladores justo para eso.
    valor: resolver(acumulado, agregacion),
    suma: acumulado.suma,
    conteo: acumulado.conteo,
    gruposPlegados: resto.length,
  });

  return visibles;
}

function rangoDeFechas(
  filas: FilaCruda[],
  colFecha: MetaColumna
): { desde: Date; hasta: Date } | null {
  const i = colFecha.indice;
  let min: Date | null = null;
  let max: Date | null = null;
  for (const fila of filas) {
    const d = valorFecha(fila[i], colFecha);
    if (!d) continue;
    if (!min || d < min) min = d;
    if (!max || d > max) max = d;
  }
  return min && max ? { desde: min, hasta: max } : null;
}

/**
 * Granularidad sugerida a partir del rango de fechas presente en los datos.
 *
 * El corte a mes es generoso a propósito: el reporte de Walmart abarca 734
 * días y con un umbral de dos años caía en "año", o sea una línea de tres
 * puntos para dos años de venta diaria. Mensual se sigue leyendo bien hasta
 * unos 60 puntos, así que sólo por encima de cinco años conviene agrupar por
 * año.
 */
export function granularidadAuto(filas: FilaCruda[], colFecha: MetaColumna): Granularidad {
  const rango = rangoDeFechas(filas, colFecha);
  return rango ? granularidadPorRango(rango.desde, rango.hasta) : "mes";
}

/** Igual que `granularidadAuto` pero desde un rango ya calculado: en el
 *  histórico el mínimo y el máximo salen de un `$group`, sin recorrer filas. */
export function granularidadPorRango(desde: Date, hasta: Date): Granularidad {
  const dias = (hasta.getTime() - desde.getTime()) / 86_400_000;
  if (dias < 60) return "dia";
  if (dias < 1825) return "mes";
  return "anio";
}

/** Avanza una clave de bucket al siguiente periodo. */
function siguienteBucket(clave: string, granularidad: Granularidad): string {
  const p = clave.split("-").map(Number);
  if (granularidad === "anio") return String(p[0] + 1);
  if (granularidad === "mes") {
    const d = new Date(p[0], p[1], 1); // mes+1 en base 0 == mes siguiente
    return claveTemporal(d, "mes");
  }
  const d = new Date(p[0], p[1] - 1, p[2] + 1);
  return claveTemporal(d, "dia");
}

export function serieTemporal(
  filas: FilaCruda[],
  colFecha: MetaColumna,
  colMetrica: MetaColumna | null,
  agregacion: Agregacion,
  granularidad: Granularidad
): PuntoSerie[] {
  const mapa = new Map<string, Acumulador>();
  const iFecha = colFecha.indice;
  const iMet = colMetrica?.indice ?? -1;

  for (const fila of filas) {
    const fecha = valorFecha(fila[iFecha], colFecha);
    if (!fecha) continue;

    let valor = 1;
    if (colMetrica) {
      const n = valorNumerico(fila[iMet], colMetrica);
      if (n === null) continue;
      valor = n;
    }

    const clave = claveTemporal(fecha, granularidad);
    const acc = mapa.get(clave);
    if (acc) {
      acc.suma += valor;
      acc.conteo++;
    } else {
      mapa.set(clave, { suma: valor, conteo: 1 });
    }
  }

  return rellenarSerie(mapa, agregacion, granularidad);
}

/**
 * Ordena los buckets y rellena los huecos con cero.
 *
 * Igual que `plegarTopN`, se separa para que el histórico entre por aquí con
 * los acumuladores que le devolvió Mongo y obtenga la misma serie que el
 * navegador.
 */
export function rellenarSerie(
  mapa: Map<string, Acumulador>,
  agregacion: Agregacion,
  granularidad: Granularidad
): PuntoSerie[] {
  if (mapa.size === 0) return [];

  const claves = [...mapa.keys()].sort();
  const primera = claves[0];
  const ultima = claves[claves.length - 1];

  // Rellenar los huecos con cero: tres meses sin ventas deben verse como una
  // caída, no como una recta que sugiere continuidad.
  const salida: PuntoSerie[] = [];
  let clave = primera;
  while (salida.length < MAX_BUCKETS) {
    const acc = mapa.get(clave);
    salida.push({ clave, valor: acc ? resolver(acc, agregacion) : 0 });
    if (clave === ultima) return salida;
    clave = siguienteBucket(clave, granularidad);
  }

  // Rango absurdamente largo (p. ej. días a lo largo de décadas): se devuelven
  // sólo los buckets con datos, sin relleno.
  return claves.map((k) => ({
    clave: k,
    valor: resolver(mapa.get(k) as Acumulador, agregacion),
  }));
}

export function calcularKpis(
  filas: FilaCruda[],
  colDimension: MetaColumna | null,
  colMetrica: MetaColumna | null,
  colFecha: MetaColumna | null
): Kpis {
  let total = 0;
  const distintos = new Set<string>();
  let desde: Date | null = null;
  let hasta: Date | null = null;

  const iDim = colDimension?.indice ?? -1;
  const iMet = colMetrica?.indice ?? -1;
  const iFecha = colFecha?.indice ?? -1;

  for (const fila of filas) {
    if (colMetrica) {
      const n = valorNumerico(fila[iMet], colMetrica);
      if (n !== null) total += n;
    } else {
      total++;
    }

    if (colDimension) distintos.add(claveDimension(fila[iDim]));

    if (colFecha) {
      const d = valorFecha(fila[iFecha], colFecha);
      if (d) {
        if (!desde || d < desde) desde = d;
        if (!hasta || d > hasta) hasta = d;
      }
    }
  }

  return {
    totalMetrica: total,
    totalFilas: filas.length,
    dimensionesDistintas: distintos.size,
    rangoFechas: desde && hasta ? { desde, hasta } : null,
  };
}
