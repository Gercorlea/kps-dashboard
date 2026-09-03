// Modelos disponibles para KPS AI vía Vercel AI Gateway (§9.1).
// Whitelist única: el servidor solo acepta IDs de esta lista y el picker
// de la UI se alimenta de aquí. Todos son Anthropic (only: ["anthropic"])
// y compatibles con Zero Data Retention. Agregar un modelo = una línea.
// Los IDs usan la convención del Gateway (creator/modelo-nombre con puntos).

export interface ModeloIA {
  id: string;
  name: string;
  precio: string; // referencia entrada/salida por millón de tokens
  entradaPorM: number; // USD por millón de tokens de entrada
  salidaPorM: number; // USD por millón de tokens de salida
  description: string;
}

export const MODELOS_IA: ModeloIA[] = [
  {
    id: "anthropic/claude-sonnet-4.6",
    name: "Sonnet 4.6",
    precio: "$3 / $15",
    entradaPorM: 3,
    salidaPorM: 15,
    description: "Equilibrio velocidad-capacidad",
  },
  {
    id: "anthropic/claude-haiku-4.5",
    name: "Haiku 4.5",
    precio: "$1 / $5",
    entradaPorM: 1,
    salidaPorM: 5,
    description: "Rápido y económico (predeterminado)",
  },
  {
    id: "anthropic/claude-opus-4.8",
    name: "Opus 4.8",
    precio: "$5 / $25",
    entradaPorM: 5,
    salidaPorM: 25,
    description: "Máxima capacidad",
  },
];

// Haiku por defecto: escribe ~2.2x más rápido que Sonnet (medido: 165 vs 75
// tokens/s), y en este producto la mayor parte de la espera es el modelo
// tecleando tablas y reportes. Quien necesite más capacidad elige Sonnet u
// Opus en el picker; el guard de abajo evita que un typo rompa el arranque.
export const MODELO_DEFECTO =
  MODELOS_IA.find((m) => m.id === "anthropic/claude-haiku-4.5")?.id ?? MODELOS_IA[0].id;

export const MODELO_IDS = MODELOS_IA.map((m) => m.id) as [string, ...string[]];

export function esModeloValido(id: unknown): id is string {
  return typeof id === "string" && MODELOS_IA.some((m) => m.id === id);
}

/**
 * Costo en USD de una llamada. Los precios son los de lista de Anthropic por
 * millón de tokens; el Gateway factura sobre esa misma base, así que es una
 * estimación fiel, no el cargo exacto de tu factura.
 *
 * Con prompt caching, `entrada` sigue siendo el total de tokens de entrada
 * pero una parte se lee del caché (10% del precio) y otra lo escribe (125%).
 * Sin el desglose, la estimación cobraría a precio pleno lo cacheado y
 * saldría hasta 10x inflada.
 */
export interface CacheEntrada {
  leidos: number; // tokens leídos del caché (cache_read)
  escritos: number; // tokens que escribieron caché (cache_creation)
}

export function costUSD(
  modeloId: string,
  entrada: number,
  salida: number,
  cache?: CacheEntrada
): number {
  const m = MODELOS_IA.find((x) => x.id === modeloId);
  if (!m) return 0;
  const leidos = cache?.leidos ?? 0;
  const escritos = cache?.escritos ?? 0;
  const plenos = Math.max(0, entrada - leidos - escritos);
  const entradaEfectiva = plenos + escritos * 1.25 + leidos * 0.1;
  return (entradaEfectiva / 1_000_000) * m.entradaPorM + (salida / 1_000_000) * m.salidaPorM;
}

/** "$0.0123" — con los decimales suficientes para que no se vea como cero. */
export function formatoUSD(costo: number): string {
  if (costo === 0) return "$0.00";
  if (costo < 0.01) return `$${costo.toFixed(5)}`;
  return `$${costo.toFixed(4)}`;
}
