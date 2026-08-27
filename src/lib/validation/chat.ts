import { z } from "zod";
import { MODELO_IDS } from "@/lib/ai-modelos";

export const objectIdSchema = z.string().regex(/^[0-9a-f]{24}$/i, "Id inválido");

// useChat (AI SDK) manda UIMessages con parts; validamos forma y tamaño
// antes de tocar el modelo (§9.2): longitud máxima de mensaje e historial.
//
// El tope por parte es para lo que ESCRIBE el usuario. Las respuestas del
// asistente vuelven en el historial de cada turno y un pronóstico con la
// serie mensual de tres retailers pasa de 8,000 caracteres: con el mismo tope
// el siguiente mensaje del usuario recibía 422 y la conversación quedaba
// inutilizable.
const MAX_TEXTO_USUARIO = 8000;
const MAX_TEXTO_ASISTENTE = 40_000;
const MAX_HISTORIAL = 160_000;

const uiPartSchema = z.looseObject({
  type: z.string(),
  text: z.string().max(MAX_TEXTO_ASISTENTE, "Message demasiado largo").optional(),
});

// Un turno con varias consultas encadenadas genera una parte por paso y otra
// por herramienta: con el tope en 20, una respuesta que consultara SAP media
// docena de veces tumbaba el SIGUIENTE mensaje. El límite protege del abuso,
// no de nuestro propio flujo, así que va por encima del máximo alcanzable.
const uiMessageSchema = z
  .looseObject({
    id: z.string().max(64).optional(),
    role: z.enum(["user", "assistant", "system"]),
    parts: z.array(uiPartSchema).max(80),
  })
  .refine(
    (m) =>
      m.role !== "user" ||
      m.parts.every((p) => typeof p.text !== "string" || p.text.length <= MAX_TEXTO_USUARIO),
    { message: "Message demasiado largo" }
  );

export const chatBodySchema = z
  .object({
    chatId: objectIdSchema.optional(),
    model: z.enum(MODELO_IDS).optional(),
    // El mismo tope que el GET de la conversación (limit 200): el cliente
    // reenvía todo el historial y con 60 una conversación larga se bloqueaba.
    messages: z.array(uiMessageSchema).min(1).max(200),
  })
  .refine(
    (b) =>
      b.messages.reduce(
        (total, m) =>
          total + m.parts.reduce((t, p) => t + (typeof p.text === "string" ? p.text.length : 0), 0),
        0
      ) <= MAX_HISTORIAL,
    { message: "El historial enviado es demasiado largo" }
  );

export const createChatSchema = z.object({
  title: z.string().min(1).max(120).optional(),
});
