// El "canal" de la hoja de mapeo → el retailer del módulo.
//
// La hoja la escribe una persona a mano, así que el canal llega como texto
// libre ("walmart", "San Pablo ", "Súper Aki"). Se convierte a slug y se compara
// contra RETAILERS, pero un canal desconocido NO se rechaza: el archivo trae
// cadenas que todavía no son retailers y perder esas filas sería perder el
// trabajo de quien mantiene el Excel. Se guarda, se muestra marcado, y no cruza
// con ventas —porque no hay ventas suyas en la base contra las que cruzar—.

import { toText } from "@/lib/retail/normalize";
import { RETAILERS } from "@/lib/retail/retailers";
import { clave } from "./normalizar";

export interface CanalResuelto {
  /** Slug que se guarda en ProductMapping.channel. */
  id: string;
  /** Nombre para mostrar: el oficial si se reconoce, el del archivo si no. */
  nombre: string;
  /** Si está en RETAILERS. Sólo los conocidos cruzan con SalesReport. */
  conocido: boolean;
}

/** "San Pablo " → "san-pablo". Es el id que se guarda. */
export function idCanal(texto: unknown): string {
  return clave(texto)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/**
 * Canal del archivo → id, nombre para mostrar y si es un retailer del módulo.
 *
 * Se compara contra el id Y contra el slug del nombre oficial, y por eso basta
 * el slug: los cuatro retailers de RETAILERS tienen id = slug de su nombre
 * ("Farmacias del Ahorro" → "farmacias-del-ahorro"), así que el archivo puede
 * escribir cualquiera de las dos formas.
 *
 * No modifica retailers.ts: sólo lo lee.
 */
export function resolverCanal(texto: unknown): CanalResuelto {
  const id = idCanal(texto);
  if (!id) return { id: "", nombre: "", conocido: false };

  const r = RETAILERS.find((x) => x.id === id || idCanal(x.nombre) === id);
  if (r) return { id: r.id, nombre: r.nombre, conocido: true };

  return { id, nombre: toText(texto), conocido: false };
}
