import type { NextRequest } from "next/server";
import { handleApiError, ok, parseJson, ApiError } from "@/lib/api";
import { verifyPassword } from "@/lib/auth/hash";
import { emitirSesion } from "@/lib/auth/session";
import { connectDB } from "@/lib/db";
import { clientIp, enforceRateLimit } from "@/lib/rate-limit";
import { loginSchema } from "@/lib/validation/auth";
import { User } from "@/models/User";

export async function POST(request: NextRequest) {
  try {
    const body = await parseJson(request, loginSchema);
    const email = body.email.toLowerCase();
    // Rate limit por IP + email (§5.6)
    await enforceRateLimit("login", `${clientIp(request)}:${email}`);

    await connectDB();
    // .lean(): los claims del JWT solo llevan primitivos (§5.2)
    const user = await User.findOne({ email }).lean();
    const passwordOk = user
      ? await verifyPassword(body.password, user.passwordHash)
      : false;
    if (!user || !passwordOk || !user.active) {
      throw new ApiError(401, "CREDENCIALES", "Correo o contraseña incorrectos");
    }

    await emitirSesion(user);
    return ok({
      id: String(user._id),
      nombre: user.nombre,
      email: user.email,
      role: user.role,
      modules: user.modules.map(String),
    });
  } catch (e) {
    return handleApiError(e);
  }
}
