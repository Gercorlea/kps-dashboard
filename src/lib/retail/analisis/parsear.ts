// Frontera de I/O del analizador: el único archivo del módulo que toca SheetJS
// y el único con import() dinámico. Todo lo que sale de aquí son estructuras
// planas que el resto del módulo trata como datos puros.
//
// Usa el mismo parser que la ingesta (`xlsx`, ver src/lib/retail/parse-workbook.ts)
// para no cargar dos librerías de Excel en la app.

import { construirColumnas, detectarEncabezado } from "./inferir-tipos";
import type { Dataset, FilaCruda, HojaCruda } from "./tipos";

/** Error con mensaje ya redactado para mostrar al usuario. */
export class ErrorExcel extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ErrorExcel";
  }
}

/** A partir de este tamaño se avisa que el análisis puede tardar. */
export const LIMITE_AVISO_BYTES = 25 * 1024 * 1024;

const RE_XLSX = /\.xlsx$/i;

/**
 * Lee todas las hojas del archivo en una sola pasada.
 *
 * Opciones alineadas con parse-workbook.ts del servidor:
 * - `cellDates: true` convierte a Date SÓLO las celdas cuyo formato de número
 *   es de fecha. Un 45000 en una celda General sigue siendo el número 45000,
 *   que es lo correcto: nunca hay que adivinar que un importe es un serial.
 * - Con la opción `UTC` en su valor por omisión (false), SheetJS devuelve
 *   fechas cuya interpretación LOCAL es la correcta, así que todo el módulo
 *   las lee con getters locales. Verificado en tests/excel-inferencia.test.ts.
 * - `dense: true` baja bastante la memoria en hojas de 15k filas.
 * - Apagar cellText/cellHTML/cellFormula evita ~300k evaluaciones de formato.
 */
export async function leerLibro(file: File): Promise<HojaCruda[]> {
  if (file.size === 0) throw new ErrorExcel("El archivo está vacío.");
  if (!RE_XLSX.test(file.name)) {
    throw new ErrorExcel("Solo se aceptan archivos .xlsx");
  }

  const XLSX = await import("xlsx");
  const bytes = new Uint8Array(await file.arrayBuffer());

  // Un .xlsx es siempre un ZIP. SheetJS es deliberadamente permisivo y ante
  // basura hace fallback a CSV/texto, así que un .txt renombrado no reventaría:
  // devolvería una hoja de una celda y el usuario vería una tabla sin sentido
  // en vez de un error. Se verifica la firma antes de entregárselo.
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new ErrorExcel("No se pudo leer el archivo. ¿Está dañado o no es un Excel válido?");
  }

  let libro;
  try {
    libro = XLSX.read(bytes, {
      type: "array",
      cellDates: true,
      dense: true,
      cellFormula: false,
      cellHTML: false,
      cellText: false,
    });
  } catch (error) {
    const mensaje = error instanceof Error ? error.message : "";
    if (/password|encrypt/i.test(mensaje)) {
      throw new ErrorExcel("El archivo está protegido con contraseña.");
    }
    throw new ErrorExcel("No se pudo leer el archivo. ¿Está dañado o no es un Excel válido?");
  }

  if (libro.SheetNames.length === 0) throw new ErrorExcel("El archivo no contiene hojas.");

  return libro.SheetNames.map((nombre) => {
    const hoja = libro.Sheets[nombre];
    const datos: FilaCruda[] = hoja
      ? XLSX.utils.sheet_to_json<FilaCruda>(hoja, {
          header: 1,
          raw: true,
          // Se conservan las filas en blanco para que el índice de fila que se
          // muestra en la tabla ("encabezado en la fila 4") coincida con la
          // numeración real de Excel; si no, auditar contra el archivo falla.
          // Las vacías se filtran después, al construir el dataset.
          blankrows: true,
          // Conserva la alineación de columnas con celdas vacías o combinadas
          // (SheetJS deja el valor sólo en la superior izquierda de una
          // combinación).
          defval: null,
        })
      : [];
    return { nombre, datos };
  });
}

function filaTieneAlgo(fila: FilaCruda | undefined): boolean {
  if (!fila) return false;
  return fila.some((v) => v !== null && v !== undefined && String(v).trim() !== "");
}

/** Primera hoja con al menos dos filas con contenido; salta las de sólo título. */
export function elegirHojaConDatos(hojas: HojaCruda[]): string {
  const conDatos = hojas.find((h) => h.datos.filter(filaTieneAlgo).length >= 2);
  return (conDatos ?? hojas[0]).nombre;
}

export function construirDataset(hojas: HojaCruda[], nombreHoja: string): Dataset {
  const hoja = hojas.find((h) => h.nombre === nombreHoja);
  if (!hoja) throw new ErrorExcel(`No se encontró la hoja «${nombreHoja}».`);

  const datos = hoja.datos;
  if (datos.length === 0) throw new ErrorExcel("El archivo no contiene filas de datos.");

  const filaEncabezado = detectarEncabezado(datos);
  const filas = datos.slice(filaEncabezado + 1).filter(filaTieneAlgo);
  if (filas.length === 0) throw new ErrorExcel("El archivo no contiene filas de datos.");

  let ancho = 0;
  if (filaEncabezado >= 0) ancho = datos[filaEncabezado].length;
  for (const fila of filas) ancho = Math.max(ancho, fila.length);
  if (ancho === 0) throw new ErrorExcel("El archivo no contiene columnas con datos.");

  const columnas = construirColumnas(
    filas,
    filaEncabezado >= 0 ? datos[filaEncabezado] : null,
    ancho
  );

  return {
    hoja: hoja.nombre,
    filaEncabezado,
    columnas,
    filas,
    totalFilas: filas.length,
  };
}
