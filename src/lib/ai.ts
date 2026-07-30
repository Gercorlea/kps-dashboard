import { streamText } from "ai";
import type { ModelMessage } from "ai";

// Toda llamada a modelos pasa por Vercel AI Gateway (§9.1). Nunca un SDK
// de proveedor directo. Auth con AI_GATEWAY_API_KEY (solo servidor).

const SYSTEM_PROMPT = `Eres Cronos IA, el asistente conversacional de Arcanum dentro de Cronos Retail.
Respondes siempre en español, de forma clara, directa y profesional.
Eres un módulo independiente: no tienes acceso a los datos del módulo Retail
(ventas, inventarios, scorecards); si te preguntan por cifras de ese módulo,
indica que se consultan en la pestaña Retail.
Si no sabes algo, dilo sin inventar.`;

export function chat(
  messages: ModelMessage[],
  opciones?: { onFinish?: (texto: string) => Promise<void> | void }
) {
  return streamText({
    model: "anthropic/claude-sonnet-4.6", // formato creator/model-name, obligatorio
    system: SYSTEM_PROMPT,
    messages,
    providerOptions: {
      gateway: {
        only: ["anthropic"], // fija el proveedor: sin fallback silencioso
        zeroDataRetention: true, // exige enrutar solo a proveedores con acuerdo ZDR
      },
    },
    onFinish: async ({ text }) => {
      await opciones?.onFinish?.(text);
    },
  });
}
