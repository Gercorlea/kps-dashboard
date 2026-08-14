// Constantes del archivo de carga. El Excel NO se almacena: el navegador lo
// envía al procesar, el servidor lo parsea en memoria y solo se guardan las
// filas resultantes en MongoDB. No hay bucket ni copia del original.

export const XLSX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export function sanitizeFilename(filename: string): string {
  return filename
    .replace(/[^\w.\-()\s]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
}
