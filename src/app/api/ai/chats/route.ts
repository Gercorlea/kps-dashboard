import type { NextRequest } from "next/server";
import { handleApiError, ok, parseJson } from "@/lib/api";
import { requireModule } from "@/lib/auth/guards";
import { connectDB } from "@/lib/db";
import { createChatSchema } from "@/lib/validation/chat";
import { Chat } from "@/models/Chat";
import { Message } from "@/models/Message";

export async function GET() {
  try {
    const session = await requireModule("cronos-ia");
    await connectDB();
    const chats = await Chat.find({ userId: session.id })
      .sort({ updatedAt: -1 })
      .limit(100)
      .lean();
    return ok({
      chats: chats.map((c) => ({
        id: String(c._id),
        title: c.title,
        updatedAt: new Date(c.updatedAt).toISOString(),
      })),
    });
  } catch (e) {
    return handleApiError(e);
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await requireModule("cronos-ia");
    const body = await parseJson(request, createChatSchema);
    await connectDB();
    const chat = await Chat.create({
      userId: session.id,
      title: body.title?.trim() || "Nueva conversación",
    });
    return ok({ id: String(chat._id), title: chat.title });
  } catch (e) {
    return handleApiError(e);
  }
}

// Borra TODAS las conversaciones del usuario con sus mensajes (el botón
// "Borrar todo" del historial). Solo toca lo del usuario de la sesión.
export async function DELETE() {
  try {
    const session = await requireModule("cronos-ia");
    await connectDB();
    const chats = await Chat.find({ userId: session.id }).select("_id").lean();
    const ids = chats.map((c) => c._id);
    if (ids.length) {
      await Message.deleteMany({ chatId: { $in: ids } });
      await Chat.deleteMany({ _id: { $in: ids } });
    }
    return ok({ eliminados: ids.length });
  } catch (e) {
    return handleApiError(e);
  }
}
