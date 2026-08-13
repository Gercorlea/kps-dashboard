import type { NextRequest } from "next/server";
import { ApiError, handleApiError, ok, parseJson } from "@/lib/api";
import { hashPassword } from "@/lib/auth/hash";
import { hashToken, revocarSesionesDeUsuario } from "@/lib/auth/session";
import { connectDB } from "@/lib/db";
import { clientIp, enforceRateLimit } from "@/lib/rate-limit";
import { restablecerSchema } from "@/lib/validation/auth";
import { User } from "@/models/User";

export async function POST(request: NextRequest) {
  try {
    const body = await parseJson(request, restablecerSchema);
    await enforceRateLimit("recuperar", clientIp(request));

    await connectDB();
    const user = await User.findOne({
      resetTokenHash: hashToken(body.token),
      resetTokenExpiresAt: { $gt: new Date() },
      active: true,
    });
    if (!user) {
      throw new ApiError(422, "TOKEN_INVALIDO", "El enlace ya no es válido. Solicita uno nuevo.");
    }

    user.passwordHash = await hashPassword(body.password);
    user.resetTokenHash = null; // un solo uso
    user.resetTokenExpiresAt = null;
    await user.save();
    // Cambio de contraseña → se revocan todas las sesiones (§5.1)
    await revocarSesionesDeUsuario(user._id);

    return ok({ message: "Contraseña actualizada. Ya puedes iniciar sesión." });
  } catch (e) {
    return handleApiError(e);
  }
}
