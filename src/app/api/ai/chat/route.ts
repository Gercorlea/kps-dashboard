import { convertToModelMessages, type UIMessage } from "ai";
import { isValidObjectId } from "mongoose";
import type { NextRequest } from "next/server";
import { ApiError, handleApiError, parseJson } from "@/lib/api";
import { chat } from "@/lib/ai";
import { requireModule } from "@/lib/auth/guards";
import { connectDB } from "@/lib/db";
import { clientIp, enforceRateLimit } from "@/lib/rate-limit";
import { chatBodySchema } from "@/lib/validation/chat";
import { Chat } from "@/models/Chat";
import { Mensaje } from "@/models/Mensaje";

export const runtime = "nodejs";
export const maxDuration = 120;

const TITULO_DEFECTO = "Nueva conversación";

function textoDe(mensaje: { parts: Array<{ type: string; text?: string }> }): string {
  return mensaje.parts
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n")
    .trim();
}

// Chat de Cronos IA (§9): módulo independiente — NO recibe datos de Retail.
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

    await Mensaje.create({
      chatId: conversacion._id,
      userId: session.id,
      rol: "user",
      contenido: textoUsuario,
    });
    if (conversacion.titulo === TITULO_DEFECTO) {
      conversacion.titulo = textoUsuario.slice(0, 60);
    }
    conversacion.updatedAt = new Date();
    await conversacion.save();

    const mensajesModelo = await convertToModelMessages(body.messages as unknown as UIMessage[]);
    const resultado = chat(mensajesModelo, {
      onFinish: async (texto) => {
        try {
          await Mensaje.create({
            chatId: conversacion._id,
            userId: session.id,
            rol: "assistant",
            contenido: texto,
          });
          await Chat.updateOne({ _id: conversacion._id }, { $set: { updatedAt: new Date() } });
        } catch (e) {
          console.error("[chat] no se pudo persistir la respuesta", e);
        }
      },
    });

    return resultado.toUIMessageStreamResponse();
  } catch (e) {
    return handleApiError(e);
  }
}
