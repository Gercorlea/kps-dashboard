import { isValidObjectId } from "mongoose";
import type { NextRequest } from "next/server";
import { ApiError, handleApiError, ok } from "@/lib/api";
import { requireModule } from "@/lib/auth/guards";
import { connectDB } from "@/lib/db";
import { Chat } from "@/models/Chat";
import { Message } from "@/models/Message";

// Ownership verificada sobre el documento en cada endpoint — un usuario
// no puede leer los chats de otro (§9.2).
async function cargarChatPropio(id: string, userId: string) {
  if (!isValidObjectId(id)) throw new ApiError(404, "NO_ENCONTRADO", "Conversación no encontrada");
  await connectDB();
  const chat = await Chat.findById(id).lean();
  if (!chat || String(chat.userId) !== userId) {
    throw new ApiError(404, "NO_ENCONTRADO", "Conversación no encontrada");
  }
  return chat;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await requireModule("cronos-ia");
    const { id } = await params;
    const chat = await cargarChatPropio(id, session.id);
    // Descendente + limit + reverse, NO ascendente + limit.
    //
    // Con `sort({ createdAt: 1 }).limit(200)` Mongo ordena del mas viejo al mas
    // nuevo y corta al final: en una conversacion de mas de 200 mensajes
    // devolvia los 200 PRIMEROS y tiraba justo los ultimos. Al reabrirla, el
    // usuario veia su conversacion congelada en un estado antiguo y lo que
    // acababa de escribir habia desaparecido de la vista —seguia en Mongo, pero
    // no habia forma de llegar a ello—. Y no se quedaba en lo cosmetico: el
    // cliente reenvia este mismo historial a POST /api/ai/chat, asi que el
    // modelo tampoco veia los ultimos turnos y la conversacion se bifurcaba
    // desde un punto viejo.
    //
    // Ordenando descendente se corta por el otro extremo —se quedan los 200 mas
    // RECIENTES— y el reverse los devuelve en orden cronologico, que es como los
    // espera la vista.
    const mensajes = (
      await Message.find({ chatId: chat._id })
        .sort({ createdAt: -1 })
        .limit(200)
        .lean()
    ).reverse();
    return ok({
      chat: { id: String(chat._id), title: chat.title },
      mensajes: mensajes.map((m) => ({
        id: String(m._id),
        role: m.role,
        content: m.content,
        tools: m.tools,
        createdAt: new Date(m.createdAt).toISOString(),
      })),
    });
  } catch (e) {
    return handleApiError(e);
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await requireModule("cronos-ia");
    const { id } = await params;
    const chat = await cargarChatPropio(id, session.id);
    await Message.deleteMany({ chatId: chat._id });
    await Chat.deleteOne({ _id: chat._id });
    return ok({ eliminado: true });
  } catch (e) {
    return handleApiError(e);
  }
}
