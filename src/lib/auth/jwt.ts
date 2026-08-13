import { SignJWT, jwtVerify } from "jose";

// JWT propio con `jose` (HS256) — funciona en edge y en Node (§5.1, §5.3).
// ⚠️ Claims solo JSON plano (§5.2): nunca documentos de Mongoose, ObjectId
// ni Date. El llamador arma el payload con primitivos.

const encoder = new TextEncoder();

function accessSecret() {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error("JWT_SECRET no está definida (ver .env.example)");
  return encoder.encode(s);
}

function refreshSecret() {
  const s = process.env.JWT_REFRESH_SECRET;
  if (!s) throw new Error("JWT_REFRESH_SECRET no está definida (ver .env.example)");
  return encoder.encode(s);
}

export const ACCESS_TTL_MIN = 15;
export const REFRESH_TTL_DIAS = 30;

export interface AccessClaims {
  sub: string;
  role: "superadmin" | "user";
  modules: string[];
}

export async function signAccessToken(payload: {
  sub: string;
  role: string;
  modules: string[];
}): Promise<string> {
  const { sub, role, modules } = payload;
  return new SignJWT({
    role,
    modules: Array.from(modules ?? []).map(String), // array plano, no Mongoose
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(String(sub)) // ObjectId -> string
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TTL_MIN}m`)
    .sign(accessSecret());
}

export async function verifyAccessToken(token: string): Promise<AccessClaims | null> {
  try {
    const { payload } = await jwtVerify(token, accessSecret());
    if (!payload.sub) return null;
    return {
      sub: String(payload.sub),
      role: payload.role === "superadmin" ? "superadmin" : "user",
      modules: Array.isArray(payload.modules) ? payload.modules.map(String) : [],
    };
  } catch {
    return null;
  }
}

// El refresh lleva un `jti` aleatorio; en DB solo se guarda el hash del token
// para poder revocarlo (logout, cambio de contraseña, expulsión de sesión).
export async function signRefreshToken(payload: { sub: string; jti: string }): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(String(payload.sub))
    .setJti(payload.jti)
    .setIssuedAt()
    .setExpirationTime(`${REFRESH_TTL_DIAS}d`)
    .sign(refreshSecret());
}

export async function verifyRefreshToken(
  token: string
): Promise<{ sub: string; jti: string } | null> {
  try {
    const { payload } = await jwtVerify(token, refreshSecret());
    if (!payload.sub || !payload.jti) return null;
    return { sub: String(payload.sub), jti: String(payload.jti) };
  } catch {
    return null;
  }
}
