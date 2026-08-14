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
    const mensajes = await Message.find({ chatId: chat._id })
      .sort({ createdAt: 1 })
      .limit(200)
      .lean();
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
