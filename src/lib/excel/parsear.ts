// Frontera de I/O del análisis de Excel: el único archivo que toca
// `read-excel-file` y el único con import() dinámico. Todo lo que sale de aquí
// son estructuras planas que el resto del módulo trata como datos puros.

import { construirColumnas, detectarEncabezado } from './inferir-tipos'
import type { Dataset, FilaCruda, HojaCruda } from './tipos'

/** Error con mensaje ya redactado para mostrar al usuario. */
export class ErrorExcel extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ErrorExcel'
  }
}

/** A partir de este tamaño se avisa que el análisis puede tardar. */
export const LIMITE_AVISO_BYTES = 25 * 1024 * 1024

const RE_XLSX = /\.xlsx$/i
const RE_XLS = /\.xls$/i

function mensajeDeError(error: unknown): string {
  const codigo =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code: unknown }).code)
      : ''

  switch (codigo) {
    case 'XLS_FILE_NOT_SUPPORTED':
      return 'Los archivos .xls antiguos no son compatibles. Ábrelo en Excel y guárdalo como .xlsx.'
    case 'NO_DATA':
      return 'El archivo no contiene hojas con datos.'
    case 'INVALID_ZIP':
    case 'FILE_NOT_SUPPORTED':
    case 'INPUT_TYPE_NOT_SUPPORTED':
      return 'No se pudo leer el archivo. ¿Está dañado o no es un Excel válido?'
    default:
      return 'No se pudo leer el archivo. ¿Está dañado o no es un Excel válido?'
  }
}

/**
 * Lee todas las hojas del archivo en una sola pasada.
 *
 * `read-excel-file/browser` ya descomprime en un Web Worker interno; sólo el
 * parseo del XML queda en el hilo principal (~200-300 ms para 15k filas), que
 * un spinner cubre de sobra. Si algún día el spawn del worker fallara bajo
 * Turbopack, el reemplazo es importar 'read-excel-file/web-worker', idéntico
 * pero sin spawnear workers.
 *
 * Ojo: el paquete no expone entrada raíz en su mapa de `exports`, así que el
 * import DEBE ser a '/browser'.
 */
export async function leerLibro(file: File): Promise<HojaCruda[]> {
  if (file.size === 0) throw new ErrorExcel('El archivo está vacío.')
  if (RE_XLS.test(file.name)) {
    throw new ErrorExcel(
      'Los archivos .xls antiguos no son compatibles. Ábrelo en Excel y guárdalo como .xlsx.',
    )
  }
  if (!RE_XLSX.test(file.name)) {
    throw new ErrorExcel('Formato no soportado. Usa un archivo .xlsx.')
  }

  const { default: readXlsxFile } = await import('read-excel-file/browser')

  let hojas
  try {
    hojas = await readXlsxFile(file)
  } catch (error) {
    throw new ErrorExcel(mensajeDeError(error))
  }

  if (!hojas || hojas.length === 0) throw new ErrorExcel('El archivo no contiene hojas.')

  // Un solo cast en toda la frontera: los tipos publicados por el paquete
  // declaran CellValue con `typeof Date` (el constructor) en vez de `Date`, lo
  // que rompe el narrowing con instanceof aguas abajo.
  return hojas.map((h) => {
    const datos = h.data as unknown as FilaCruda[]
    normalizarFechas(datos)
    return { nombre: h.sheet, datos }
  })
}

/**
 * read-excel-file entrega las fechas de celda como medianoche UTC. Leerlas con
 * getters locales en un huso negativo (America/Mexico_City es UTC-6) devuelve
 * el DÍA ANTERIOR: el 01/01/2023 se convierte en 31/12/2022, y las ventas de
 * fin de mes se van al mes equivocado.
 *
 * Se renormalizan aquí, en la frontera, a medianoche LOCAL del mismo día
 * calendario. Así el resto del código vive con un único invariante: toda fecha
 * se lee con getters locales. Se muta en sitio porque los arreglos los acaba de
 * crear la librería y nadie más los tiene.
 *
 * Exportada para poder verificarla sin navegador.
 */
export function normalizarFechas(filas: FilaCruda[]): void {
  for (const fila of filas) {
    for (let c = 0; c < fila.length; c++) {
      const v = fila[c]
      if (v instanceof Date && !Number.isNaN(v.getTime())) {
        fila[c] = new Date(v.getUTCFullYear(), v.getUTCMonth(), v.getUTCDate())
      }
    }
  }
}

function filaTieneAlgo(fila: FilaCruda | undefined): boolean {
  if (!fila) return false
  return fila.some((v) => v !== null && v !== undefined && String(v).trim() !== '')
}

/** Primera hoja con al menos dos filas con contenido; salta las de sólo título. */
export function elegirHojaConDatos(hojas: HojaCruda[]): string {
  const conDatos = hojas.find((h) => h.datos.filter(filaTieneAlgo).length >= 2)
  return (conDatos ?? hojas[0]).nombre
}

export function construirDataset(hojas: HojaCruda[], nombreHoja: string): Dataset {
  const hoja = hojas.find((h) => h.nombre === nombreHoja)
  if (!hoja) throw new ErrorExcel(`No se encontró la hoja «${nombreHoja}».`)

  const datos = hoja.datos
  if (datos.length === 0) throw new ErrorExcel('El archivo no contiene filas de datos.')

  const filaEncabezado = detectarEncabezado(datos)
  const filas = datos.slice(filaEncabezado + 1).filter(filaTieneAlgo)
  if (filas.length === 0) throw new ErrorExcel('El archivo no contiene filas de datos.')

  let ancho = 0
  if (filaEncabezado >= 0) ancho = datos[filaEncabezado].length
  for (const fila of filas) ancho = Math.max(ancho, fila.length)
  if (ancho === 0) throw new ErrorExcel('El archivo no contiene columnas con datos.')

  const columnas = construirColumnas(
    filas,
    filaEncabezado >= 0 ? datos[filaEncabezado] : null,
    ancho,
  )

  return {
    hoja: hoja.nombre,
    filaEncabezado,
    columnas,
    filas,
    totalFilas: filas.length,
  }
}
