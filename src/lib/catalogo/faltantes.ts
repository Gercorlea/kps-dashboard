// Qué productos del catálogo de KPS no tiene dados de alta un retailer.
//
// Es la pregunta inversa a la que contesta el resto del módulo retail: aquella
// sale de SalesReport y sólo sabe de lo que sí se vendió, así que un producto
// que la cadena nunca dio de alta no aparece por ninguna parte. El universo lo
// tiene que poner el catálogo, y quien sabe si hay alta es la hoja de mapeo
// (ver models/ProductMapping.ts).
//
// No se cruza con las ventas: "dado de alta" es tener código en esa hoja, y eso
// se decide sin mirar un solo reporte. Un producto con alta que no ha vendido
// nada es un problema distinto —de rotación, no de listado— y no es el que esta
// pestaña resuelve.
//
// Este módulo es PURO y no importa ningún modelo, por el mismo motivo que
// retailers.ts no importa zod: la pestaña lo usa desde el navegador y un import
// de Mongoose, aunque fuera de tipos, arrastraría el driver entero al bundle del
// cliente y rompería la compilación. Las consultas viven en la ruta que lo
// consume, igual que en /api/catalogo/mapeo y /api/catalogo/resumen.

import { clave, normalizarItem } from "./normalizar";

/**
 * Los estatus que forman el universo, por clave normalizada.
 *
 * Pedirle a una cadena que dé de alta un producto descatalogado no es un hueco
 * accionable, y uno en desarrollo todavía no existe para venderse.
 */
export const ESTATUS_VENDIBLES = ["activo", "lanzamiento"] as const;

/**
 * Si el estatus entra en el universo.
 *
 * Igualdad exacta sobre la clave, nunca subcadena, por el mismo motivo que
 * documenta estatus.ts: "inactivo" CONTIENE "activo", y un reconocedor por
 * subcadena contaría como vendible un producto dado de baja.
 */
export function esVendible(status: string): boolean {
  return (ESTATUS_VENDIBLES as readonly string[]).includes(clave(status));
}

/** Lo mínimo que hace falta de una fila de mapeo DE ESE canal. */
export interface MapeoDeCanal {
  sku: string;
  customerCode: string;
}

/**
 * Los productos del catálogo que la cadena no tiene dados de alta.
 *
 * Genérica en el producto para no obligar a la ruta a recortar los campos antes
 * de llamar: lo único que se mira es `item` y `status`.
 *
 * Una fila de mapeo con el código VACÍO no cuenta como alta: el modelo la
 * describe como "el caso normal de un producto que la cadena todavía no ha dado
 * de alta", así que ese producto sigue siendo un hueco.
 */
export function productosSinAlta<T extends { item: string; status: string }>(
  productos: T[],
  mapeos: MapeoDeCanal[]
): T[] {
  // Se normaliza aunque el lector del Excel ya lo hizo al cargar: es idempotente
  // y blinda el cruce contra una grafía que se colara por otra puerta —el alta
  // manual de esta misma pestaña, sin ir más lejos—. Sin esto el producto
  // seguiría saliendo como faltante después de darlo de alta y nada explicaría
  // por qué.
  const conAlta = new Set(
    mapeos.filter((m) => m.customerCode.trim()).map((m) => normalizarItem(m.sku))
  );
  return productos.filter((p) => esVendible(p.status) && !conAlta.has(normalizarItem(p.item)));
}
