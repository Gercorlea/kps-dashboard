import crypto from "node:crypto";
import { isValidObjectId } from "mongoose";
import type { NextRequest } from "next/server";
import { ApiError, handleApiError, ok, parseJson } from "@/lib/api";
import { requireSuperadmin } from "@/lib/auth/guards";
import { hashToken, revocarSesionesDeUsuario } from "@/lib/auth/session";
import { connectDB } from "@/lib/db";
import { sendPasswordResetEmail } from "@/lib/email";
import { updateUserSchema, userActionSchema } from "@/lib/validation/admin";
import { User } from "@/models/User";

async function cargarUsuario(id: string) {
  if (!isValidObjectId(id)) throw new ApiError(404, "NO_ENCONTRADO", "Usuario no encontrado");
  await connectDB();
  const user = await User.findById(id);
  if (!user) throw new ApiError(404, "NO_ENCONTRADO", "Usuario no encontrado");
  return user;
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requireSuperadmin();
    const { id } = await params;
    const body = await parseJson(request, updateUserSchema);
    const user = await cargarUsuario(id);

    if (user.role === "superadmin" && body.active === false) {
      throw new ApiError(422, "VALIDACION", "No se puede desactivar a un superadmin");
    }

    if (body.name !== undefined) user.name = body.name;
    if (body.modules !== undefined && user.role !== "superadmin") user.modules = body.modules;
    if (body.active !== undefined) user.active = body.active;
    await user.save();

    // Desactivar → expulsar sesiones activas (§5.1)
    if (body.active === false) await revocarSesionesDeUsuario(user._id);

    return ok({ actualizado: true });
  } catch (e) {
    return handleApiError(e);
  }
}

// Acciones: resetear contraseña (correo por Resend) y revocar sesiones (§10).
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requireSuperadmin();
    const { id } = await params;
    const body = await parseJson(request, userActionSchema);
    const user = await cargarUsuario(id);

    if (body.accion === "revocar-sesiones") {
      await revocarSesionesDeUsuario(user._id);
      return ok({ message: "Sesiones revocadas" });
    }

    // reset-password
    const token = crypto.randomBytes(32).toString("hex");
    user.resetTokenHash = hashToken(token);
    user.resetTokenExpiresAt = new Date(Date.now() + 30 * 60 * 1000);
    await user.save();
    const base = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
    await sendPasswordResetEmail(user.email, `${base}/restablecer/${token}`);
    return ok({ message: `Correo de restablecimiento enviado a ${user.email}` });
  } catch (e) {
    return handleApiError(e);
  }
}
