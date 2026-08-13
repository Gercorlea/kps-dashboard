import crypto from "node:crypto";
import type { Types } from "mongoose";
import { setSessionCookies } from "@/lib/auth/cookies";
import { REFRESH_TTL_DIAS, signAccessToken, signRefreshToken } from "@/lib/auth/jwt";
import { RefreshToken } from "@/models/RefreshToken";

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

// Emite access + refresh y persiste SOLO el hash del refresh (§5.1).
// ⚠️ Los claims van con primitivos: quien llama debe pasar el usuario
// leído con .lean() (§5.2).
export async function emitirSesion(user: {
  _id: Types.ObjectId | string;
  role: string;
  modules: string[];
}): Promise<void> {
  const accessToken = await signAccessToken({
    sub: String(user._id),
    role: user.role,
    modules: Array.from(user.modules ?? []).map(String),
  });
  const jti = crypto.randomUUID();
  const refreshToken = await signRefreshToken({ sub: String(user._id), jti });
  await RefreshToken.create({
    userId: user._id,
    tokenHash: hashToken(refreshToken),
    expiresAt: new Date(Date.now() + REFRESH_TTL_DIAS * 24 * 60 * 60 * 1000),
  });
  await setSessionCookies(accessToken, refreshToken);
}

export async function revocarRefreshPorToken(token: string): Promise<void> {
  await RefreshToken.updateOne(
    { tokenHash: hashToken(token), revokedAt: null },
    { $set: { revokedAt: new Date() } }
  );
}

export async function revocarSesionesDeUsuario(userId: Types.ObjectId | string): Promise<void> {
  await RefreshToken.updateMany(
    { userId, revokedAt: null },
    { $set: { revokedAt: new Date() } }
  );
}
