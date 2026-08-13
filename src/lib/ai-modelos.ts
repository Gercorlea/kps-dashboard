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
    description: "Equilibrio velocidad-capacidad (predeterminado)",
  },
  {
    id: "anthropic/claude-haiku-4.5",
    name: "Haiku 4.5",
    precio: "$1 / $5",
    entradaPorM: 1,
    salidaPorM: 5,
    description: "Rápido y económico",
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

export const MODELO_DEFECTO = MODELOS_IA[0].id;

export const MODELO_IDS = MODELOS_IA.map((m) => m.id) as [string, ...string[]];

export function esModeloValido(id: unknown): id is string {
  return typeof id === "string" && MODELOS_IA.some((m) => m.id === id);
}

/**
 * Costo en USD de una llamada. Los precios son los de lista de Anthropic por
 * millón de tokens; el Gateway factura sobre esa misma base, así que es una
 * estimación fiel, no el cargo exacto de tu factura.
 */
export function costUSD(modeloId: string, entrada: number, salida: number): number {
  const m = MODELOS_IA.find((x) => x.id === modeloId);
  if (!m) return 0;
  return (entrada / 1_000_000) * m.entradaPorM + (salida / 1_000_000) * m.salidaPorM;
}

/** "$0.0123" — con los decimales suficientes para que no se vea como cero. */
export function formatoUSD(costo: number): string {
  if (costo === 0) return "$0.00";
  if (costo < 0.01) return `$${costo.toFixed(5)}`;
  return `$${costo.toFixed(4)}`;
}
