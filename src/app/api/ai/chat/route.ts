import { convertToModelMessages, pruneMessages, type UIMessage } from "ai";
import { isValidObjectId } from "mongoose";
import type { NextRequest } from "next/server";
import { ApiError, handleApiError, parseJson } from "@/lib/api";
import { chat } from "@/lib/ai";
import { MODELO_DEFECTO, costUSD, esModeloValido } from "@/lib/ai-modelos";
import { requireModule } from "@/lib/auth/guards";
import { connectDB } from "@/lib/db";
import { clientIp, enforceRateLimit } from "@/lib/rate-limit";
import { chatBodySchema } from "@/lib/validation/chat";
import { Chat } from "@/models/Chat";
import { Message } from "@/models/Message";

export const runtime = "nodejs";
// Un reporte largo puede tardar: 120 s se quedaban cortos y la petición
// moría a mitad del streaming.
export const maxDuration = 300;

const TITULO_DEFECTO = "Nueva conversación";

function textoDe(message: { parts: Array<{ type: string; text?: string }> }): string {
  return message.parts
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n")
    .trim();
}

// Chat de KPS AI (§9): módulo independiente — NO recibe datos de Retail.
// Streaming vía Vercel AI Gateway; historial persistido y scopeado por
// usuario: la propiedad se verifica en cada request, no solo en el listado.
export async function POST(request: NextRequest) {
  try {
    const session = await requireModule("cronos-ia");
    // El endpoint cuesta dinero por token: rate limiting obligatorio (§5.6).
    await enforceRateLimit("chat", `${clientIp(request)}:${session.id}`);
    const body = await parseJson(request, chatBodySchema);

    await connectDB();
    if (!body.chatId || !isValidObjectId(body.chatId)) {
      throw new ApiError(422, "VALIDACION", "Falta el chatId de la conversación");
    }
    const conversacion = await Chat.findById(body.chatId);
    if (!conversacion || String(conversacion.userId) !== session.id) {
      throw new ApiError(404, "NO_ENCONTRADO", "Conversación no encontrada");
    }

    const ultimo = body.messages[body.messages.length - 1];
    if (ultimo.role !== "user") {
      throw new ApiError(422, "VALIDACION", "El último mensaje debe ser del usuario");
    }
    const textoUsuario = textoDe(ultimo);
    if (!textoUsuario) {
      throw new ApiError(422, "VALIDACION", "El mensaje está vacío");
    }

    await Message.create({
      chatId: conversacion._id,
      userId: session.id,
      role: "user",
      content: textoUsuario,
    });
    if (conversacion.title === TITULO_DEFECTO) {
      conversacion.title = textoUsuario.slice(0, 60);
    }
    conversacion.updatedAt = new Date();
    await conversacion.save();

    // Sin podar, cada consulta a SAP (hasta 100 filas) se reenvía íntegra en
    // TODOS los mensajes siguientes: una conversación normal pasaba de 190 mil
    // tokens de entrada y acababa fallando. Se conservan las llamadas de los
    // dos últimos mensajes —las que el modelo aún necesita— y del resto queda
    // solo el texto, que ya resume lo encontrado.
    const mensajesModelo = pruneMessages({
      messages: await convertToModelMessages(body.messages as unknown as UIMessage[]),
      toolCalls: "before-last-2-messages",
      emptyMessages: "remove",
    });
    const result = chat(mensajesModelo, {
      model: body.model,
      onFinish: async ({ texto, model, entrada, salida, cache, tools }) => {
        try {
          await Message.create({
            chatId: conversacion._id,
            userId: session.id,
            role: "assistant",
            content: texto,
            model,
            inputTokens: entrada,
            outputTokens: salida,
            costUSD: costUSD(model, entrada, salida, cache),
            tools: tools.length ? tools : undefined,
          });
          await Chat.updateOne({ _id: conversacion._id }, { $set: { updatedAt: new Date() } });
        } catch (e) {
          console.error("[chat] no se pudo persistir la respuesta", e);
        }
      },
    });

    // El consumo viaja al cliente como metadata del mensaje: así el chat
    // muestra tokens y costo sin una petición extra.
    const modeloUsado = esModeloValido(body.model) ? body.model : MODELO_DEFECTO;
    return result.toUIMessageStreamResponse({
      // Un fallo posterior a la apertura del stream —consulta a SAP, límite del
      // proveedor, timeout de la función— ya no puede volverse respuesta HTTP:
      // las cabeceras salieron y el catch de abajo nunca lo ve. Sin esto el SDK
      // lo enmascara y el cliente solo puede decir "intenta de nuevo". Se emite
      // con el contrato { error: { message } } que espera motivoDelError.
      onError: (error) => {
        console.error("[chat] fallo durante el streaming", error);
        const message =
          error instanceof Error ? error.message : "Error generando la respuesta";
        return JSON.stringify({ error: { message } });
      },
      messageMetadata: ({ part }) => {
        if (part.type !== "finish") return undefined;
        const entrada = part.totalUsage?.inputTokens ?? 0;
        const salida = part.totalUsage?.outputTokens ?? 0;
        const cache = {
          leidos: part.totalUsage?.inputTokenDetails?.cacheReadTokens ?? 0,
          escritos: part.totalUsage?.inputTokenDetails?.cacheWriteTokens ?? 0,
        };
        return {
          model: modeloUsado,
          entrada,
          salida,
          costo: costUSD(modeloUsado, entrada, salida, cache),
        };
      },
    });
  } catch (e) {
    return handleApiError(e);
  }
}
