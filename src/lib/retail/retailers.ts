// Los retailers de los que se reciben reportes de venta.
//
// Módulo aparte de validation/retail.ts —y sin zod— para que la lista se pueda
// importar desde un componente de cliente sin arrastrar los esquemas.
//
// Ojo: NO es lo mismo que `CUENTAS`. Esa lista es la del flujo de ingesta por
// hojas fijas, que hoy sólo sabe procesar San Pablo; ampliarla dejaría crear
// cargas que ese flujo no puede leer. Aquí se listan las cuentas del
// analizador, que acepta cualquier reporte con plantilla reconocida.

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
