import { cookies } from "next/headers";
import { ApiError } from "@/lib/api";
import { ACCESS_COOKIE } from "@/lib/auth/cookies";
import { verifyAccessToken } from "@/lib/auth/jwt";
import { canAccess, type ModuleId } from "@/lib/rbac";

// Doble capa de protección (§5.4): proxy.ts hace el check optimista global;
// estos guards son la verificación real por ruta y por módulo.

export interface SessionUser {
  id: string;
  role: "superadmin" | "user";
  modules: string[];
}

export async function getSessionUser(): Promise<SessionUser | null> {
  const store = await cookies();
  const token = store.get(ACCESS_COOKIE)?.value;
  if (!token) return null;
  const claims = await verifyAccessToken(token);
  if (!claims) return null;
  return { id: claims.sub, role: claims.role, modules: claims.modules };
}

export async function requireUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) throw new ApiError(401, "NO_AUTENTICADO", "Sesión no válida o expirada");
  return user;
}

export async function requireModule(module: ModuleId): Promise<SessionUser> {
  const user = await requireUser();
  if (!canAccess(user, module)) {
    throw new ApiError(403, "SIN_PERMISO", `No tienes acceso al módulo ${module}`);
  }
  return user;
}

export async function requireSuperadmin(): Promise<SessionUser> {
  const user = await requireUser();
  if (user.role !== "superadmin") {
    throw new ApiError(403, "SIN_PERMISO", "Esta acción requiere rol superadmin");
  }
  return user;
}
