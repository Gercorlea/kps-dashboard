// Memoria de proceso para los agregados de retail.
//
// Está aquí por una medición, no por costumbre. Sobre las 15,344 filas de
// Walmart, cinco corridas seguidas del $facet de /api/retail/analisis/resumen
// dieron 1.8 s, 3.6 s, 5.9 s, 2.1 s y 3.7 s, y detalleRetailers() otras
// 2.9 s / 1.5 s / 0.2 s. El clúster es compartido y el pipeline hace siete
// pasadas por la colección, así que el rango es enorme y siempre caro.
//
// Lo que sale de ahí son 56 KB que sólo cambian cuando alguien guarda o borra
// un reporte —un acto manual, unas cuantas veces al mes—, de modo que recalcular
// en cada visita a la ficha del retailer es pagar segundos por un dato que ya
// se tenía. Por eso el resultado se guarda y se invalida a mano en las dos
// rutas que escriben (POST /api/retail/analisis y DELETE .../reporte), en vez
// de fiarlo todo a un TTL corto que dejaría fría la mitad de las visitas.
//
// Se guarda la PROMESA y no el valor ya resuelto, y esa es la otra mitad del
// arreglo: dos peticiones idénticas que llegan a la vez comparten UNA sola
// agregación en lugar de disparar dos. Cubre el doble montaje de React en
// desarrollo y, en producción, a dos personas abriendo la misma ficha a la vez.

/** Red de seguridad por si algo escribe en la colección fuera de las rutas. */
const TTL_MS = 10 * 60_000;

/**
 * Tope de entradas. `sourceFile` y el periodo vienen de la query, así que sin
 * un límite un cliente en bucle podría hacer crecer el mapa sin fin.
 *
 * Eran 64 cuando la clave sólo combinaba retailer × alcance × parte. Con el
 * filtro de periodo de la ficha entran los rangos (cuatro trimestres y el año
 * por cada año con datos, más los personalizados), y la expulsión de abajo es
 * por orden de INSERCIÓN y no por uso: con el tope viejo, pasear por los
 * trimestres de un retailer echaba las entradas calientes de los otros.
 */
const MAX_ENTRADAS = 256;

interface Entrada {
  valor: Promise<unknown>;
  nacida: number;
}

// En `global` por el mismo motivo que la conexión de db.ts: sin esto el
// hot-reload de dev tira la memoria en cada edición y nunca se ve un acierto.
const globalConCache = global as typeof globalThis & {
  _retailCache?: Map<string, Entrada>;
};
const cache: Map<string, Entrada> = globalConCache._retailCache ?? new Map();
globalConCache._retailCache = cache;

/**
 * Devuelve lo que hay guardado para `clave`, o lo calcula una sola vez.
 *
 * La entrada se borra si `calcular` falla: dejar cacheada una promesa rechazada
 * convertiría un error puntual de red en un error permanente hasta el TTL.
 */
export function memoRetail<T>(clave: string, calcular: () => Promise<T>): Promise<T> {
  const previa = cache.get(clave);
  if (previa && Date.now() - previa.nacida < TTL_MS) return previa.valor as Promise<T>;

  const valor = calcular().catch((e: unknown) => {
    cache.delete(clave);
    throw e;
  });
  cache.set(clave, { valor, nacida: Date.now() });

  // Map itera en orden de inserción, así que la primera clave es la más vieja.
  while (cache.size > MAX_ENTRADAS) {
    const vieja = cache.keys().next().value;
    if (vieja === undefined) break;
    cache.delete(vieja);
  }
  return valor;
}

/**
 * Tira TODO lo guardado. Se llama al guardar o borrar un reporte.
 *
 * No se afina por retailer a propósito: media docena de entradas se recalculan
 * solas en la siguiente visita, y decidir cuáles sobreviven a una escritura es
 * justo el tipo de detalle que se equivoca en silencio y deja una gráfica
 * mostrando el reporte anterior.
 */
export function invalidarRetail(): void {
  cache.clear();
}
