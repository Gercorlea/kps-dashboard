import type { PipelineStage, Types } from "mongoose";

// Procedencia de una fila del histórico: en qué archivos aparece.
//
// El upsert va por la clave natural (account, itemNbr, date), que NO incluye el
// archivo. Eso es deliberado —es lo que impide que volver a subir un reporte
// duplique el histórico— y tiene una consecuencia: dos reportes que se solapan
// (feb-mar y luego mar-abr) COMPARTEN las filas de marzo.
//
// Mientras la procedencia fue un escalar, "compartir" no se podía representar y
// el segundo reporte se las quitaba al primero: éste perdía marzo de su conteo,
// de su periodo y de sus totales, y el botón de borrar del segundo se llevaba
// filas ajenas. La pertenencia de una fila a un archivo es de MUCHOS A MUCHOS.
//
// Aquí está modelada como tal: `sourceFiles` es un conjunto que se acumula con
// $addToSet. El registro compartido aparece en los dos reportes y sigue siendo
// UN solo documento, así que ninguna agregación por cuenta —las gráficas— lo
// cuenta dos veces.
//
// Las piezas viven aquí y no en cada ruta para que la lista de reportes de un
// retailer, la ficha de un reporte y el borrado cuenten exactamente lo mismo.

/** Una fila lista para el histórico, en lo que a la clave natural respecta. */
interface FilaConClave {
  itemNbr: number;
  date: string;
}

/** Lo que identifica a una carga y queda estampado en cada fila que toca. */
export interface Procedencia {
  template: string;
  account: string;
  sourceFile: string;
  importedAt: Date;
  importedBy: Types.ObjectId;
}

/**
 * Filtro de "las filas que contiene este archivo".
 *
 * Mongo compara un escalar contra un arreglo por CONTENCIÓN, así que esto
 * encuentra la fila tanto si el archivo es su único dueño como si la comparte.
 * Es la única forma de preguntar por un reporte: la usan la tabla paginada, el
 * bundle con alcance=archivo, la ficha y el borrado.
 */
export function filasDelArchivo(account: string, sourceFile: string) {
  return { account, sourceFiles: sourceFile };
}

/**
 * Operación de bulkWrite para una fila.
 *
 * Las dos mitades del update dicen cosas distintas a propósito:
 *
 *  · `$set` — las MÉTRICAS las pisa la última carga. Si dos archivos traen el
 *    mismo registro con cifras distintas (un reporte corregido), quedan las del
 *    más reciente.
 *  · `$addToSet` — la PROCEDENCIA no se pisa, se acumula. Es lo único que
 *    separa "este archivo también tiene la fila" de "este archivo se la quedó".
 *
 * `fecha` llega ya anclada a medianoche UTC por el llamador: la conversión
 * depende del formato de entrada y no de la procedencia.
 */
export function operacionDeFila<T extends FilaConClave>(
  fila: T,
  fecha: Date,
  proc: Procedencia
) {
  return {
    updateOne: {
      filter: { account: proc.account, itemNbr: fila.itemNbr, date: fecha },
      update: {
        $set: {
          ...fila,
          // Pisa el ISO que trae la fila: la clave natural se compara contra un
          // Date, y un texto no casaría con el filtro de arriba.
          date: fecha,
          template: proc.template,
          account: proc.account,
          importedAt: proc.importedAt,
          importedBy: proc.importedBy,
        },
        $addToSet: { sourceFiles: proc.sourceFile },
      },
      upsert: true,
    },
  };
}

/**
 * Cuántas filas tiene cada archivo de la cuenta.
 *
 * El $unwind cuenta la fila compartida en LOS DOS reportes, así que la suma de
 * la columna es mayor que el total del histórico. Es lo correcto: la pregunta
 * es cuántas filas trae cada archivo, no cómo repartirse las filas entre ellos.
 *
 * Proyectar antes del $unwind no es cosmético: sin él, cada fila desdoblada
 * arrastra las métricas y las dimensiones del reporte por la tubería.
 */
export function pipelineFilasPorArchivo(filtro: Record<string, unknown>): PipelineStage[] {
  return [
    { $match: filtro },
    { $project: { sourceFiles: 1 } },
    { $unwind: "$sourceFiles" },
    { $group: { _id: "$sourceFiles", filas: { $sum: 1 } } },
  ];
}

/** Una fila de "Reportes guardados", ya con sus fechas resueltas. */
export interface ReporteListado<A> {
  sourceFile: string;
  filas: number;
  importado: Date | null;
  actualizado: Date | null;
  subidoPor: A | null;
}

/**
 * Junta los reportes con sus conteos de filas.
 *
 * Un reporte con 0 filas no se esconde: significa que todas las suyas se
 * borraron desde otro reporte que también las tenía, y es un estado que la
 * lista tiene que poder mostrar en vez de hacer desaparecer la fila.
 */
export function reportesListados<A>(
  reportes: {
    sourceFile: string;
    importedAt: Date;
    reimportedAt: Date | null;
    importedBy: A;
  }[],
  conteos: { _id: string; filas: number }[]
): ReporteListado<A>[] {
  const porArchivo = new Map(conteos.map((c) => [c._id, c.filas]));
  return reportes.map((r) => ({
    sourceFile: r.sourceFile,
    filas: porArchivo.get(r.sourceFile) ?? 0,
    importado: r.importedAt,
    actualizado: r.reimportedAt,
    subidoPor: r.importedBy,
  }));
}
