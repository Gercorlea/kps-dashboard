// El periodo del filtro de la ficha del retailer.
//
// Módulo puro. Todo se calcula sobre claves ISO ("YYYY-MM-DD") comparadas como
// TEXTO, que para fechas con ceros a la izquierda es la comparación
// cronológica: no entra ni un Date con getters locales, que es de donde salen
// los corrimientos de un día que ya se pagaron una vez en agregar.ts.

import type { VentanaAnual } from "./agregar";

/**
 * Un tramo de fechas. Sirve tanto para el rango CON DATOS del retailer —el que
 * pone los topes de los inputs— como para el periodo que se acaba aplicando.
 */
export interface RangoISO {
  desde: string;
  hasta: string;
}

/**
 * En qué punto está el par de fechas escritas en el filtro.
 *
 * - `vacio`: los dos inputs en blanco. Sin filtro, todo el histórico.
 * - `incompleto`: sólo uno. NO se aplica: elegir la primera fecha no puede
 *   mover las gráficas, porque un periodo con un extremo suelto no es el que la
 *   persona está a punto de pedir —y cada intento costaría un viaje al servidor
 *   para tirarlo dos segundos después—.
 * - `invertido`: los dos, pero al revés. Tampoco se aplica: un $gte mayor que
 *   el $lte no falla, devuelve cero filas, y eso se leería como "este retailer
 *   no vendió nada".
 * - `listo`: los dos y en orden. Es el único caso que se pide.
 */
export type EstadoPeriodo = "vacio" | "incompleto" | "invertido" | "listo";

/**
 * Decide qué hacer con lo que hay escrito. Vive aquí, y no en el componente,
 * porque la respuesta la necesitan los dos lados: quién pide el bundle acotado
 * y quién le dice a la persona por qué todavía no pasa nada.
 */
export function estadoDelPeriodo(desde: string, hasta: string): EstadoPeriodo {
  if (!desde && !hasta) return "vacio";
  if (!desde || !hasta) return "incompleto";
  // Comparación de texto: la clave ISO con ceros a la izquierda ordena
  // alfabéticamente igual que cronológicamente.
  return desde <= hasta ? "listo" : "invertido";
}

/**
 * Meses que toca el rango, y el año, cuando cae dentro de UN año calendario.
 *
 * Es lo que decide si la comparativa anual puede ser "el mismo periodo del año
 * pasado": para enero–marzo de 2026 devuelve `{ anio: 2026, meses: [1, 2, 3] }`
 * y la gráfica compara contra esos tres meses de 2025. Un rango a caballo entre
 * dos años devuelve null, porque ahí "el año anterior" no significa nada.
 */
export function ventanaDelRango(desde: string, hasta: string): VentanaAnual | null {
  const anio = Number(desde.slice(0, 4));
  if (Number(hasta.slice(0, 4)) !== anio) return null;

  const meses: number[] = [];
  for (let m = Number(desde.slice(5, 7)); m <= Number(hasta.slice(5, 7)); m++) meses.push(m);
  return meses.length > 0 ? { anio, meses } : null;
}
