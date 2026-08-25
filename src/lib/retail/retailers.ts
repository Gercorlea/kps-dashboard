// Los retailers de los que se reciben reportes de venta.
//
// Módulo aparte de validation/retail.ts —y sin zod— para que la lista se pueda
// importar desde un componente de cliente sin arrastrar los esquemas.
//
// Son las cuentas del analizador, que acepta cualquier reporte con plantilla
// reconocida.

export interface Retailer {
  /** Se guarda en `account`; no cambiar sin migrar los documentos existentes. */
  id: string;
  nombre: string;
}

export const RETAILERS: Retailer[] = [
  { id: "san-pablo", nombre: "San Pablo" },
  { id: "walmart", nombre: "Walmart" },
  { id: "heb", nombre: "HEB" },
  { id: "farmacias-del-ahorro", nombre: "Farmacias del Ahorro" },
];

export const RETAILER_IDS = RETAILERS.map((r) => r.id) as [string, ...string[]];

/** Nombre para mostrar. Un id desconocido se devuelve tal cual en vez de
 *  desaparecer: si en la base hay una cuenta vieja, mejor verla que ocultarla. */
export function nombreRetailer(id: string): string {
  return RETAILERS.find((r) => r.id === id)?.nombre ?? id;
}

// Color de cada retailer en la gráfica del dashboard. Se resuelve por POSICIÓN
// en RETAILERS y no por orden de aparición para que la línea de Walmart sea del
// mismo color aunque cambie de lugar en el ranking. Tokens --viz-* de
// globals.css, la paleta validada para daltonismo (la misma que el analizador).
const COLORES_RETAILER = ["var(--viz-1)", "var(--viz-2)", "var(--viz-3)", "var(--viz-4)"];
const COLOR_OTRO = "var(--viz-6)";

/** Cuentas fuera de la lista comparten color: son la excepción, no una serie. */
export function colorRetailer(id: string): string {
  const i = RETAILERS.findIndex((r) => r.id === id);
  return i < 0 ? COLOR_OTRO : COLORES_RETAILER[i % COLORES_RETAILER.length];
}
