import type { PipelineStage } from "mongoose";

// Cuándo se importó un reporte, y cuándo se actualizó.
//
// El histórico hace upsert por la clave natural (account, itemNbr, date), que
// NO incluye el archivo. De ahí salen dos efectos que hay que separar bien:
//
//  1. Volver a subir el MISMO reporte sobrescribe `importedAt`/`importedBy` de
//     cada fila. La fecha original vive en `firstImportedAt`, escrita una sola
//     vez con $setOnInsert.
//  2. Subir un reporte que SE SOLAPA con otro —feb-mar y después mar-abr— le
//     quita al primero las filas de marzo: pasan a llevar el `sourceFile` del
//     segundo, pero conservan el `firstImportedAt` del primero, que es cuando
//     nacieron.
//
// Por (2) un reporte no se puede fechar agrupando por `sourceFile`. Mar-abr
// heredaba las filas de marzo y con ellas la fecha de carga de feb-mar, así que
// salía "importado" el día del primero y su fecha real aparecía abajo, como si
// fuera una actualización. `firstSourceFile` —qué carga CREÓ cada fila— es lo
// que deshace el enredo:
//
//   importado(F)   = la primera escritura de las filas que creó F
//   actualizado(F) = la última vez que se reescribió una fila creada por F, sea
//                    F otra vez, sea la carga que se la quitó; null si no ha
//                    pasado
//
// Con eso, feb-mar queda importado su día y actualizado el día en que llegó
// mar-abr —que es cuando dejó de tener marzo—, y mar-abr queda importado su día
// y sin actualización.
//
// Las piezas viven aquí y no en cada ruta para que la lista de reportes de un
// retailer y la ficha de un reporte cuenten exactamente lo mismo.

/**
 * Campos derivados de la primera escritura de cada fila. Van en un $project
 * antes de agrupar, y dejan listos `primerImport` para `ULTIMA_ACTUALIZACION` y
 * `primerArchivo` para agrupar por carga.
 */
export const PRIMERA_ESCRITURA = {
  // Las filas guardadas antes de que los campos existieran sólo tienen una
  // escritura conocida: la que quedó en importedAt/importedBy.
  primerImport: { $ifNull: ["$firstImportedAt", "$importedAt"] },
  primerAutor: { $ifNull: ["$firstImportedBy", "$importedBy"] },

  // `firstSourceFile` es el único de los tres que NO se puede rescatar hacia
  // atrás, y por eso lleva su propia lógica en vez de un $ifNull a secas.
  //
  // De una fila anterior al campo sólo se sabe qué archivo la tiene hoy. Si
  // nadie la ha reescrito desde que nació, ése es también el que la creó y se
  // le atribuye. Si la reescribieron —importedAt por delante de la primera
  // escritura—, quién la creó no se guardó nunca: se deja SIN atribuir en vez
  // de dársela al archivo que se la quedó, que es justo el error que hacía que
  // el segundo reporte heredara la fecha de carga del primero.
  //
  // Las filas sin atribuir caen todas en el grupo `_id: null`, que nadie busca
  // por nombre: no fechan ningún reporte. Con eso, el histórico que ya está
  // guardado también deja de mostrar la fecha equivocada; lo único que no se
  // puede reconstruir de él es la "última actualización" del reporte al que le
  // quitaron filas antes de este cambio.
  primerArchivo: {
    $ifNull: [
      "$firstSourceFile",
      {
        $cond: [
          { $gt: ["$importedAt", { $ifNull: ["$firstImportedAt", "$importedAt"] }] },
          null,
          "$sourceFile",
        ],
      },
    ],
  },
};

/**
 * Acumulador de la fecha de la última carga que reescribió alguna fila del
 * reporte; null si nunca se volvió a tocar.
 *
 * Se compara contra la primera escritura de LA MISMA fila en vez de mirar el
 * rango de `importedAt` del reporte: una sola carga viaja en lotes de 2000
 * filas (MAX_FILAS_LOTE), cada uno con su marca de tiempo, así que un reporte
 * recién subido tiene ocho `importedAt` distintos sin que nadie lo haya
 * actualizado. $max ignora los nulos.
 */
export const ULTIMA_ACTUALIZACION = {
  $max: { $cond: [{ $gt: ["$importedAt", "$primerImport"] }, "$importedAt", null] },
};

/**
 * Acumuladores que fechan una carga. Van en un $group por `primerArchivo`, o
 * sea sobre las filas que ese archivo CREÓ, estén hoy a su nombre o no.
 *
 * El $group tiene que venir precedido de `{ $sort: { primerImport: 1 } }`: es lo
 * que le da sentido al $first de `subidoPor` —la fila más antigua es la de la
 * carga original— cuando el mismo nombre de archivo lo subieron dos personas
 * distintas en dos momentos.
 */
export const POR_CARGA = {
  importado: { $min: "$primerImport" },
  actualizado: ULTIMA_ACTUALIZACION,
  subidoPor: { $first: "$primerAutor" },
};

/** Lo que devuelve el $group de `POR_CARGA`, ya sin el _id. */
export interface FechasDeCarga<A> {
  importado: Date | null;
  actualizado: Date | null;
  subidoPor: A | null;
}

/**
 * Lo que un archivo tiene HOY a su nombre: el $group por `sourceFile`.
 *
 * Las filas se cuentan por aquí, y no por la carga que las creó, porque es lo
 * que el resto de la interfaz llama "un reporte": lo que abre la ficha, lo que
 * pagina la tabla y lo que se lleva el botón de borrar.
 */
export interface TenenciaAgrupada<A> {
  _id: string;
  filas: number;
  /** Sólo para ordenar la lista: el reporte tocado más recientemente va primero. */
  ultimaEscritura: Date | null;
  /** Escritura más antigua que dejó; ver `fechasDeCarga`. */
  respaldoImportado: Date | null;
  respaldoAutor: A | null;
}

/**
 * Cuándo se cargó cada archivo: el $group por `primerArchivo`. El `_id` es null
 * en el grupo de las filas viejas sin atribuir (ver `PRIMERA_ESCRITURA`), que
 * no fecha ningún reporte porque nadie lo busca por nombre.
 */
export interface CargaAgrupada<A> extends FechasDeCarga<A> {
  _id: string | null;
}

/** Una fila de "Reportes guardados", ya con sus fechas resueltas. */
export interface ReporteFechado<A> extends FechasDeCarga<A> {
  sourceFile: string;
  filas: number;
}

/**
 * Fechas de un reporte, con el respaldo para el archivo que no creó ninguna
 * fila.
 *
 * Eso pasa cuando un archivo se queda con TODAS las filas de otro y no aporta
 * ninguna nueva: el mismo periodo subido con otro nombre ("marzo v2.xlsx").
 * Entonces no hay ninguna fila con `primerArchivo` suyo de la que sacar su
 * fecha de carga, y se cae a la escritura más antigua que dejó en el histórico
 * —que es justo el momento en que se subió—.
 *
 * `actualizado` queda en null en ese caso a propósito: no creó nada, así que no
 * hay nada creado por él que alguien haya podido reescribir después.
 *
 * @param carga Resultado del $group por `primerArchivo`; undefined si el
 *   archivo no creó ninguna fila.
 * @param respaldo Escritura más antigua de las filas que el archivo tiene HOY.
 */
export function fechasDeCarga<A>(
  carga: FechasDeCarga<A> | undefined,
  respaldo: { importado: Date | null; autor: A | null }
): FechasDeCarga<A> {
  if (carga?.importado) return carga;
  return { importado: respaldo.importado, actualizado: null, subidoPor: respaldo.autor };
}

/**
 * Pipeline de "Reportes guardados": un archivo por fila, con sus fechas.
 *
 * Son dos preguntas distintas sobre las mismas filas, y por eso un $facet: qué
 * tiene cada archivo hoy se agrupa por `sourceFile`, pero cuándo se cargó se
 * agrupa por la carga que creó las filas (`primerArchivo`). Agrupar las dos
 * cosas por `sourceFile` es lo que hacía que un reporte solapado heredara la
 * fecha de importación del anterior junto con sus filas.
 *
 * El $limit va sólo en la rama de archivos: la de cargas tiene como mucho una
 * fila por archivo de la cuenta y hay que poder buscar en ella por nombre.
 */
export function pipelineDeReportes(
  filtro: Record<string, unknown>,
  limite: number
): PipelineStage[] {
  return [
    { $match: filtro },
    // Proyectar antes de ordenar: los $sort de abajo son en memoria y no tienen
    // por qué arrastrar las métricas de cada fila.
    {
      $project: {
        sourceFile: 1,
        importedAt: 1,
        importedBy: 1,
        ...PRIMERA_ESCRITURA,
      },
    },
    {
      $facet: {
        archivos: [
          // Por importedAt ascendente para que el $first sea la escritura más
          // antigua que dejó el archivo: el respaldo de `fechasDeCarga`.
          { $sort: { importedAt: 1 } },
          {
            $group: {
              _id: "$sourceFile",
              filas: { $sum: 1 },
              ultimaEscritura: { $max: "$importedAt" },
              respaldoImportado: { $min: "$importedAt" },
              respaldoAutor: { $first: "$importedBy" },
            },
          },
          { $sort: { ultimaEscritura: -1 } },
          { $limit: limite },
        ],
        cargas: [
          { $sort: { primerImport: 1 } },
          { $group: { _id: "$primerArchivo", ...POR_CARGA } },
        ],
      },
    },
  ];
}

/** Junta las dos ramas de `pipelineDeReportes` en la lista que se devuelve. */
export function reportesFechados<A>(
  agrupado:
    | { archivos: TenenciaAgrupada<A>[]; cargas: CargaAgrupada<A>[] }
    | undefined
): ReporteFechado<A>[] {
  const cargas = new Map((agrupado?.cargas ?? []).map((c) => [c._id, c]));
  return (agrupado?.archivos ?? []).map((a) => ({
    sourceFile: a._id,
    filas: a.filas,
    ...fechasDeCarga(cargas.get(a._id), {
      importado: a.respaldoImportado,
      autor: a.respaldoAutor,
    }),
  }));
}

/**
 * Ramas de $facet que fechan UN archivo, para la ficha del reporte.
 *
 * Miran sólo las filas que el archivo CREÓ, las tenga hoy o se las haya quedado
 * una carga posterior, así que el $match de la ficha tiene que traer también
 * esas (`$or` con `firstSourceFile`) y el $project dejar `primerArchivo`.
 *
 * `ultimoAutor` sale del mismo conjunto: quien reescribió por última vez algo
 * creado por este reporte es quien lo actualizó, aunque lo hiciera subiendo
 * otro archivo que se solapa con él.
 */
export function ramasDeUnReporte(sourceFile: string): {
  carga: PipelineStage.FacetPipelineStage[];
  ultimoAutor: PipelineStage.FacetPipelineStage[];
} {
  return {
    carga: [
      { $match: { primerArchivo: sourceFile } },
      { $sort: { primerImport: 1 } },
      { $group: { _id: null, ...POR_CARGA } },
    ],
    ultimoAutor: [
      { $match: { primerArchivo: sourceFile } },
      { $group: { _id: "$importedBy", hasta: { $max: "$importedAt" } } },
      { $sort: { hasta: -1 } },
      { $limit: 1 },
    ],
  };
}
