// El color del estatus de un producto.
//
// `status` es texto libre en la base —lo escribe a mano quien mantiene el Excel
// y el módulo lo guarda tal cual (ver models/CatalogProduct.ts)—, pero el
// vocabulario que hoy se usa son estos cuatro valores. Lo que no esté aquí se
// muestra igual, con su texto original, sólo que sin color: nunca se oculta ni
// se sustituye.

import { clave } from "./normalizar";

/** Tonos que admite el Badge del design system. */
export type TonoEstatus = "ok" | "warn" | "danger" | "ai" | "neutro";

/**
 * Vocabulario cerrado, por igualdad exacta sobre la clave normalizada.
 *
 * Exacta y no por subcadena a propósito: "inactivo" CONTIENE "activo", así que
 * un reconocedor por subcadena pintaría de verde un producto dado de baja —el
 * error que este badge existe para evitar—. Con igualdad no hay orden que
 * respetar ni trampas de ese tipo.
 *
 * `clave()` ya absorbe acentos, mayúsculas y espacios sobrantes, así que
 * "  ACTIVO " y "Activo" entran por la misma puerta.
 *
 * Para añadir un estatus nuevo basta una línea aquí.
 */
const TONOS: Record<string, TonoEstatus> = {
  activo: "ok",
  lanzamiento: "warn",
  desarrollo: "ai",
  descatalogado: "danger",
};

/** Tono del estatus; "neutro" para cualquier valor fuera del vocabulario. */
export function tonoEstatus(status: string): TonoEstatus {
  return TONOS[clave(status)] ?? "neutro";
}
