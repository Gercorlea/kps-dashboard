// Agregaciones sobre las filas crudas. Módulo puro y sin imports de runtime.
//
// Todo recorre las filas con un solo `for` y un solo Map: nada de cadenas
// .map().filter().reduce() sobre 15k filas.

import { valorFecha, valorNumerico } from './inferir-tipos'
import type {
  Agregacion,
  FilaCruda,
  Granularidad,
  Kpis,
  MetaColumna,
  PuntoAgrupado,
  PuntoSerie,
} from './tipos'

export const SIN_VALOR = '(sin valor)'
export const OTROS = 'Otros'

const MAX_BUCKETS = 2000

type Acumulador = { suma: number; conteo: number }

function resolver(acc: Acumulador, agregacion: Agregacion): number {
  if (agregacion === 'conteo') return acc.conteo
  if (agregacion === 'promedio') return acc.conteo === 0 ? 0 : acc.suma / acc.conteo
  return acc.suma
}

function dosDigitos(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/**
 * Clave textual de un valor de dimensión. Las fechas se normalizan a
 * YYYY-MM-DD con getters LOCALES para no correrse un día por zona horaria.
 */
function claveDimension(v: unknown): string {
  if (v === null || v === undefined) return SIN_VALOR
  if (v instanceof Date) {
    return `${v.getFullYear()}-${dosDigitos(v.getMonth() + 1)}-${dosDigitos(v.getDate())}`
  }
  const s = String(v).trim()
  return s === '' ? SIN_VALOR : s
}

/**
 * Bucket temporal. Con ceros a la izquierda, para que el orden alfabético de
 * las claves sea el orden cronológico.
 */
export function claveTemporal(d: Date, granularidad: Granularidad): string {
  const anio = d.getFullYear()
  if (granularidad === 'anio') return String(anio)
  const mes = dosDigitos(d.getMonth() + 1)
  if (granularidad === 'mes') return `${anio}-${mes}`
  return `${anio}-${mes}-${dosDigitos(d.getDate())}`
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
  topN: number,
): PuntoAgrupado[] {
  const mapa = new Map<string, Acumulador>()
  const iDim = colDimension.indice
  const iMet = colMetrica?.indice ?? -1

  for (const fila of filas) {
    let valor = 1
    if (colMetrica) {
      const n = valorNumerico(fila[iMet], colMetrica)
      // Una fila sin métrica legible no aporta ni a la suma ni al promedio.
      if (n === null) continue
      valor = n
    }

    // Las filas de subtotal / "TOTAL GENERAL" que traen los exports suelen
    // venir con la dimensión vacía. Se agrupan en (sin valor), visibles en la
    // gráfica, en vez de fusionarse en silencio o descartarse adivinando.
    const clave = claveDimension(fila[iDim])
    const acc = mapa.get(clave)
    if (acc) {
      acc.suma += valor
      acc.conteo++
    } else {
      mapa.set(clave, { suma: valor, conteo: 1 })
    }
  }

  const puntos: PuntoAgrupado[] = []
  for (const [clave, acc] of mapa) {
    puntos.push({ clave, valor: resolver(acc, agregacion), suma: acc.suma, conteo: acc.conteo })
  }
  puntos.sort((a, b) => b.valor - a.valor)

  if (puntos.length <= topN) return puntos

  const visibles = puntos.slice(0, topN)
  const resto = puntos.slice(topN)
  const acumulado: Acumulador = { suma: 0, conteo: 0 }
  for (const p of resto) {
    acumulado.suma += p.suma
    acumulado.conteo += p.conteo
  }

  visibles.push({
    clave: OTROS,
    // Con promedio esto es Σsuma/Σconteo, no el promedio de los promedios
    // descartados: el bucket guarda ambos acumuladores justo para eso.
    valor: resolver(acumulado, agregacion),
    suma: acumulado.suma,
    conteo: acumulado.conteo,
    gruposPlegados: resto.length,
  })

  return visibles
}

/** Granularidad sugerida a partir del rango de fechas presente en los datos. */
export function granularidadAuto(filas: FilaCruda[], colFecha: MetaColumna): Granularidad {
  const rango = rangoDeFechas(filas, colFecha)
  if (!rango) return 'mes'
  const dias = (rango.hasta.getTime() - rango.desde.getTime()) / 86_400_000
  if (dias < 60) return 'dia'
  if (dias < 730) return 'mes'
  return 'anio'
}

function rangoDeFechas(
  filas: FilaCruda[],
  colFecha: MetaColumna,
): { desde: Date; hasta: Date } | null {
  const i = colFecha.indice
  let min: Date | null = null
  let max: Date | null = null
  for (const fila of filas) {
    const d = valorFecha(fila[i], colFecha)
    if (!d) continue
    if (!min || d < min) min = d
    if (!max || d > max) max = d
  }
  return min && max ? { desde: min, hasta: max } : null
}

/** Avanza una clave de bucket al siguiente periodo. */
function siguienteBucket(clave: string, granularidad: Granularidad): string {
  const p = clave.split('-').map(Number)
  if (granularidad === 'anio') return String(p[0] + 1)
  if (granularidad === 'mes') {
    const d = new Date(p[0], p[1], 1) // mes+1 en base 0 == mes siguiente
    return claveTemporal(d, 'mes')
  }
  const d = new Date(p[0], p[1] - 1, p[2] + 1)
  return claveTemporal(d, 'dia')
}

export function serieTemporal(
  filas: FilaCruda[],
  colFecha: MetaColumna,
  colMetrica: MetaColumna | null,
  agregacion: Agregacion,
  granularidad: Granularidad,
): PuntoSerie[] {
  const mapa = new Map<string, Acumulador>()
  const iFecha = colFecha.indice
  const iMet = colMetrica?.indice ?? -1

  for (const fila of filas) {
    const fecha = valorFecha(fila[iFecha], colFecha)
    if (!fecha) continue

    let valor = 1
    if (colMetrica) {
      const n = valorNumerico(fila[iMet], colMetrica)
      if (n === null) continue
      valor = n
    }

    const clave = claveTemporal(fecha, granularidad)
    const acc = mapa.get(clave)
    if (acc) {
      acc.suma += valor
      acc.conteo++
    } else {
      mapa.set(clave, { suma: valor, conteo: 1 })
    }
  }

  if (mapa.size === 0) return []

  const claves = [...mapa.keys()].sort()
  const primera = claves[0]
  const ultima = claves[claves.length - 1]

  // Rellenar los huecos con cero: tres meses sin ventas deben verse como una
  // caída, no como una recta que sugiere continuidad.
  const salida: PuntoSerie[] = []
  let clave = primera
  while (salida.length < MAX_BUCKETS) {
    const acc = mapa.get(clave)
    salida.push({ clave, valor: acc ? resolver(acc, agregacion) : 0 })
    if (clave === ultima) return salida
    clave = siguienteBucket(clave, granularidad)
  }

  // Rango absurdamente largo (p. ej. días a lo largo de décadas): se devuelven
  // sólo los buckets con datos, sin relleno.
  return claves.map((k) => ({ clave: k, valor: resolver(mapa.get(k)!, agregacion) }))
}

export function calcularKpis(
  filas: FilaCruda[],
  colDimension: MetaColumna | null,
  colMetrica: MetaColumna | null,
  colFecha: MetaColumna | null,
): Kpis {
  let total = 0
  const distintos = new Set<string>()
  let desde: Date | null = null
  let hasta: Date | null = null

  const iDim = colDimension?.indice ?? -1
  const iMet = colMetrica?.indice ?? -1
  const iFecha = colFecha?.indice ?? -1

  for (const fila of filas) {
    if (colMetrica) {
      const n = valorNumerico(fila[iMet], colMetrica)
      if (n !== null) total += n
    } else {
      total++
    }

    if (colDimension) distintos.add(claveDimension(fila[iDim]))

    if (colFecha) {
      const d = valorFecha(fila[iFecha], colFecha)
      if (d) {
        if (!desde || d < desde) desde = d
        if (!hasta || d > hasta) hasta = d
      }
    }
  }

  return {
    totalMetrica: total,
    totalFilas: filas.length,
    dimensionesDistintas: distintos.size,
    rangoFechas: desde && hasta ? { desde, hasta } : null,
  }
}
