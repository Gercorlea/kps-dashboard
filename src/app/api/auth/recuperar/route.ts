import crypto from "node:crypto";
import type { NextRequest } from "next/server";
import { handleApiError, ok, parseJson } from "@/lib/api";
import { hashToken } from "@/lib/auth/session";
import { connectDB } from "@/lib/db";
import { sendPasswordResetEmail } from "@/lib/email";
import { clientIp, enforceRateLimit } from "@/lib/rate-limit";
import { recuperarSchema } from "@/lib/validation/auth";
import { User } from "@/models/User";

const RESET_TTL_MIN = 30;

// Recuperación por Resend con token de un solo uso y expiración corta
// (§5.1). La respuesta es idéntica exista o no la cuenta.
export async function POST(request: NextRequest) {
  try {
    const body = await parseJson(request, recuperarSchema);
    const email = body.email.toLowerCase();
    await enforceRateLimit("recuperar", `${clientIp(request)}:${email}`);

    await connectDB();
    const user = await User.findOne({ email, active: true });
    if (user) {
      const token = crypto.randomBytes(32).toString("hex");
      user.resetTokenHash = hashToken(token);
      user.resetTokenExpiresAt = new Date(Date.now() + RESET_TTL_MIN * 60 * 1000);
      await user.save();
      const base = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
      await sendPasswordResetEmail(user.email, `${base}/restablecer/${token}`);
    }
    return ok({
      message: "Si el correo existe, se envió un enlace de recuperación.",
    });
  } catch (e) {
    return handleApiError(e);
  }
}
