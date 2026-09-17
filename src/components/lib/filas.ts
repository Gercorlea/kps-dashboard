/**
 * Reconstruye objetos a partir de los arreglos que mandan las rutas de tabla.
 *
 * Varias rutas proyectan sus filas como ARREGLOS, en el orden de una constante
 * CAMPOS_* que hace de contrato entre el servidor y el navegador: repetir el
 * nombre de cada campo en cada fila es la mayor parte del JSON. Esta es la otra
 * mitad de ese trato, y vive aparte porque ya la usan el módulo de catálogo y
 * la pestaña de faltantes de la ficha del retailer.
 */
export function aFilas<T>(campos: readonly string[], filas: unknown[][]): T[] {
  return filas.map((f) => {
    const o: Record<string, unknown> = {};
    campos.forEach((c, i) => {
      o[c] = f[i];
    });
    return o as T;
  });
}
