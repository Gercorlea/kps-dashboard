// Cuándo se importó un reporte, y cuándo se actualizó.
//
// El histórico hace upsert por la clave natural (account, itemNbr, date), así
// que volver a subir el mismo reporte SOBRESCRIBE `importedAt` e `importedBy` de
// cada fila. La fecha original vive en `firstImportedAt`, que se escribe una
// sola vez con $setOnInsert.
//
// Estas piezas se comparten entre la lista de reportes de un retailer y la ficha
// de un reporte para que las dos cuenten lo mismo: una fila con
// `importedAt > firstImportedAt` es, exactamente, una fila que reescribió una
// carga posterior.

/**
 * Campos derivados de la primera escritura de cada fila. Van en un $project
 * antes de agrupar por reporte, y dejan listo `primerImport` para
 * `ULTIMA_ACTUALIZACION`.
 */
export const PRIMERA_ESCRITURA = {
  // Las filas guardadas antes de que el campo existiera sólo tienen una
  // escritura conocida: la que quedó en importedAt.
  primerImport: { $ifNull: ["$firstImportedAt", "$importedAt"] },
  primerAutor: { $ifNull: ["$firstImportedBy", "$importedBy"] },
};

/**
 * Acumulador de la fecha de la última carga que reescribió alguna fila del
 * reporte; null si nunca se volvió a subir.
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
