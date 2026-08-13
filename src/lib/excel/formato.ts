// Formateadores Intl creados UNA sola vez a nivel de módulo.
// Construir un Intl.NumberFormat por celda es un freno de ~10x en tablas grandes.

const LOCALE = 'es-MX'

const nfEntero = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 })

const nfDecimal = new Intl.NumberFormat(LOCALE, {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

const nfCompacto = new Intl.NumberFormat(LOCALE, {
  notation: 'compact',
  maximumFractionDigits: 1,
})

const dfFecha = new Intl.DateTimeFormat(LOCALE, {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
})

const dfMes = new Intl.DateTimeFormat(LOCALE, { month: 'short', year: 'numeric' })

/** Conteos y totales de filas: 15234 -> "15,234" */
export function formatearEntero(n: number): string {
  return nfEntero.format(n)
}

/** Valores de métrica. Los enteros no arrastran ",00" innecesario. */
export function formatearNumero(n: number): string {
  if (!Number.isFinite(n)) return '—'
  return Number.isInteger(n) ? nfEntero.format(n) : nfDecimal.format(n)
}

/** Etiquetas de eje y de barra, donde el ancho manda: 1234567 -> "1.2 M" */
export function formatearCompacto(n: number): string {
  if (!Number.isFinite(n)) return '—'
  return Math.abs(n) >= 10_000 ? nfCompacto.format(n) : formatearNumero(n)
}

export function formatearFecha(d: Date): string {
  return dfFecha.format(d)
}

export function formatearPorcentaje(fraccion: number): string {
  if (!Number.isFinite(fraccion)) return '—'
  return `${(fraccion * 100).toFixed(1)}%`
}

/** Valor de celda cruda -> texto para la tabla. */
export function formatearCelda(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (v instanceof Date) return formatearFecha(v)
  if (typeof v === 'number') return formatearNumero(v)
  if (typeof v === 'boolean') return v ? 'Sí' : 'No'
  return String(v)
}

/**
 * Etiqueta legible para una clave de bucket temporal (ver agregar.ts).
 * Recibe "2024", "2024-03" o "2024-03-15".
 */
export function formatearClaveTemporal(clave: string): string {
  const partes = clave.split('-')
  if (partes.length === 1) return clave
  const anio = Number(partes[0])
  const mes = Number(partes[1]) - 1
  if (partes.length === 2) return dfMes.format(new Date(anio, mes, 1))
  return dfFecha.format(new Date(anio, mes, Number(partes[2])))
}
