// Búsqueda de texto sobre las filas crudas. Módulo puro y sin imports de
// runtime, como agregar.ts.
//
// Existe para el archivo recién cargado, que vive en memoria del navegador. El
// histórico pagina y busca en Mongo, pero el criterio es el mismo: subcadena,
// sin distinguir mayúsculas ni acentos, sobre las columnas de texto y códigos.

import type { CeldaCruda, FilaCruda, MetaColumna } from "./tipos";

/**
 * "Cápsulas 500MG" → "capsulas 500mg".
 *
 * Sin acentos porque los reportes mezclan "ANALGÉSICO" y "ANALGESICO" en la
 * misma columna y el usuario no debería tener que adivinar cuál escribió el
 * proveedor.
 */
export function normalizarBusqueda(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

function textoDeCelda(v: CeldaCruda): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  return "";
}

/**
 * Filas que contienen `texto` en alguna de `columnas`. Con texto vacío devuelve
 * el mismo arreglo (misma referencia), para que los useMemo de arriba no
 * recalculen cuando el buscador está en blanco.
 */
export function filtrarFilas(
  filas: FilaCruda[],
  columnas: MetaColumna[],
  texto: string
): FilaCruda[] {
  const q = normalizarBusqueda(texto);
  if (q === "" || columnas.length === 0) return filas;

  const indices = columnas.map((c) => c.indice);
  return filas.filter((fila) =>
    indices.some((i) => normalizarBusqueda(textoDeCelda(fila[i])).includes(q))
  );
}

// ------------------------------------------------- la misma búsqueda, en Mongo

// Familias de letras que el usuario no debería tener que distinguir. La ñ entra
// a propósito: NFD ya la pliega del lado del cliente, y las dos búsquedas tienen
// que dar el mismo resultado.
const EQUIVALENTES: Record<string, string> = {
  a: "aáàäâã",
  e: "eéèëê",
  i: "iíìïî",
  o: "oóòöôõ",
  u: "uúùüû",
  n: "nñ",
  c: "cç",
};

function escaparRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Patrón de Mongo equivalente a `filtrarFilas`.
 *
 * `$regex` con `$options: "i"` ignora mayúsculas pero NO acentos, y la
 * collation de MongoDB no se aplica a las expresiones regulares. Sin esto,
 * buscar "analgesico" encontraría "ANALGÉSICO" en el archivo recién cargado y
 * no lo encontraría en el histórico: el mismo buscador daría dos respuestas.
 *
 * Se quitan los acentos de lo tecleado y cada letra se abre a su familia, así
 * que el patrón calza escriba quien escriba el acento, o ninguno.
 */
export function patronSinAcentos(texto: string): string {
  const plano = normalizarBusqueda(texto);
  return escaparRegex(plano)
    .split("")
    .map((ch) => (EQUIVALENTES[ch] ? `[${EQUIVALENTES[ch]}]` : ch))
    .join("");
}

/** Número de páginas para un total dado; nunca menos de una. */
export function totalPaginas(total: number, porPagina: number): number {
  return Math.max(1, Math.ceil(total / porPagina));
}

/**
 * Página `pagina` (1-based) de `filas`. Se acota la página al rango válido: al
 * teclear en el buscador el total se encoge y la página actual puede quedar
 * fuera, y mostrar una tabla vacía cuando sí hay resultados sería un error.
 */
export function paginar<T>(filas: T[], pagina: number, porPagina: number): T[] {
  const paginas = totalPaginas(filas.length, porPagina);
  const p = Math.min(Math.max(1, pagina), paginas);
  return filas.slice((p - 1) * porPagina, p * porPagina);
}
