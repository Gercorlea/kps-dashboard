import { z } from "zod";
import { MODELO_IDS } from "@/lib/ai-modelos";

export const objectIdSchema = z.string().regex(/^[0-9a-f]{24}$/i, "Id inválido");

// useChat (AI SDK) manda UIMessages con parts; validamos forma y tamaño
// antes de tocar el modelo (§9.2): longitud máxima de mensaje e historial.
const uiPartSchema = z.looseObject({
  type: z.string(),
  text: z.string().max(8000, "Message demasiado largo").optional(),
});

// Un turno con varias consultas encadenadas genera una parte por paso y otra
// por herramienta: con el tope en 20, una respuesta que consultara SAP media
// docena de veces tumbaba el SIGUIENTE mensaje. El límite protege del abuso,
// no de nuestro propio flujo, así que va por encima del máximo alcanzable.
const uiMessageSchema = z.looseObject({
  id: z.string().max(64).optional(),
  role: z.enum(["user", "assistant", "system"]),
  parts: z.array(uiPartSchema).max(80),
});

export const chatBodySchema = z
  .object({
    chatId: objectIdSchema.optional(),
    model: z.enum(MODELO_IDS).optional(),
    messages: z.array(uiMessageSchema).min(1).max(60),
  })
  .refine(
    (b) =>
      b.messages.reduce(
        (total, m) =>
          total + m.parts.reduce((t, p) => t + (typeof p.text === "string" ? p.text.length : 0), 0),
        0
      ) <= 64000,
    { message: "El historial enviado es demasiado largo" }
  );

export const createChatSchema = z.object({
  title: z.string().min(1).max(120).optional(),
});
