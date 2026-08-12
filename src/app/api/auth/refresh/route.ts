import type { NextRequest } from "next/server";
import { ApiError, handleApiError, ok } from "@/lib/api";
import { REFRESH_COOKIE, clearSessionCookies } from "@/lib/auth/cookies";
import { verifyRefreshToken } from "@/lib/auth/jwt";
import { emitirSesion, hashToken } from "@/lib/auth/session";
import { connectDB } from "@/lib/db";
import { clientIp, enforceRateLimit } from "@/lib/rate-limit";
import { RefreshToken } from "@/models/RefreshToken";
import { User } from "@/models/User";

// Rotación en cada refresh: el token anterior se invalida (§5.1).
export async function POST(request: NextRequest) {
  try {
    await enforceRateLimit("refresh", clientIp(request));

    const token = request.cookies.get(REFRESH_COOKIE)?.value;
    const claims = token ? await verifyRefreshToken(token) : null;
    if (!token || !claims) {
      await clearSessionCookies();
      throw new ApiError(401, "NO_AUTENTICADO", "Sesión no válida o expirada");
    }

    await connectDB();
    const guardado = await RefreshToken.findOne({ tokenHash: hashToken(token) });
    if (!guardado || guardado.revokedAt || guardado.expiresAt < new Date()) {
      await clearSessionCookies();
      throw new ApiError(401, "NO_AUTENTICADO", "Sesión revocada o expirada");
    }

    const user = await User.findById(claims.sub).lean();
    if (!user || !user.active) {
      await clearSessionCookies();
      throw new ApiError(401, "NO_AUTENTICADO", "Usuario inactivo");
    }

    guardado.revokedAt = new Date();
    await guardado.save();
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
