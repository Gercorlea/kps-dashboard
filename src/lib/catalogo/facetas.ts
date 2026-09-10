// Las opciones de los `select` de filtro, con su conteo.
//
// El conteo NO es del catálogo entero: es de lo que queda tras aplicar los DEMÁS
// filtros. Si se filtra por la línea "bloom" y son 30 productos, el menú de
// Estatus tiene que repartir esos 30 entre sus opciones, no seguir enseñando el
// total de la carga. Un número que no cambia al filtrar no informa de nada y
// además engaña: invita a elegir una opción que va a devolver cero.
//
// Cada filtro se cuenta excluyendo SU PROPIA selección (ver facetasCon en
// CatalogoModulo): si se incluyera, elegir "bloom" dejaría el menú de Línea con
// una sola opción y no habría forma de cambiar a otra.

import type { Faceta } from "./tipos";

/** Cómo se lee la faceta de una fila: con qué id agrupa y cómo se llama. */
export type LeerFaceta<T> = (fila: T) => { id: string; etiqueta: string };

/** La grafía más repetida de un grupo, o la primera si todas empatan. */
function masFrecuente(grafias: string[]): string {
  const conteo = new Map<string, number>();
  for (const g of grafias) conteo.set(g, (conteo.get(g) ?? 0) + 1);
  let mejor = grafias[0] ?? "";
  let max = 0;
  for (const [g, n] of conteo) {
    if (n > max) {
      max = n;
      mejor = g;
    }
  }
  return mejor;
}

/**
 * Opciones de un filtro, con el conteo que corresponde al resto de filtros.
 *
 * Los dos conjuntos hacen cosas distintas y por eso van separados:
 *
 * - `todas` fija QUÉ opciones existen y cómo se llaman. Sale del catálogo
 *   completo, así que la lista del menú no cambia mientras se filtra: una opción
 *   que ahora mismo no tiene filas se queda enseñando "(0)" en vez de
 *   desaparecer. Si desapareciera y además estuviera elegida, el `<select>`
 *   perdería su valor y el filtro se vaciaría solo.
 * - `visibles` decide CUÁNTAS filas tiene cada opción en este momento.
 *
 * Las opciones con id vacío se descartan: una celda sin valor no es una opción
 * de filtro, es un hueco.
 */
export function facetasCon<T>(todas: T[], visibles: T[], leer: LeerFaceta<T>): Faceta[] {
  const grafias = new Map<string, string[]>();
  for (const fila of todas) {
    const { id, etiqueta } = leer(fila);
    if (!id) continue;
    const lista = grafias.get(id);
    if (lista) lista.push(etiqueta);
    else grafias.set(id, [etiqueta]);
  }

  const conteo = new Map<string, number>();
  for (const fila of visibles) {
    const { id } = leer(fila);
    if (!id) continue;
    conteo.set(id, (conteo.get(id) ?? 0) + 1);
  }

  return [...grafias.entries()]
    .map(([id, gs]) => ({ id, etiqueta: masFrecuente(gs), filas: conteo.get(id) ?? 0 }))
    // Primero lo que más pesa; las que quedaron en cero caen solas al final.
    // El desempate por id mantiene el orden estable entre renders.
    .sort((a, b) => b.filas - a.filas || a.id.localeCompare(b.id, "es"));
}
