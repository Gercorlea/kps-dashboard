import type { NextRequest } from "next/server";
import { handleApiError, ok, parseJson } from "@/lib/api";
import { requireModule } from "@/lib/auth/guards";
import { connectDB } from "@/lib/db";
import { createChatSchema } from "@/lib/validation/chat";
import { Chat } from "@/models/Chat";

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
        titulo: c.titulo,
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
      titulo: body.titulo?.trim() || "Nueva conversación",
    });
    return ok({ id: String(chat._id), titulo: chat.titulo });
  } catch (e) {
    return handleApiError(e);
  }
}
