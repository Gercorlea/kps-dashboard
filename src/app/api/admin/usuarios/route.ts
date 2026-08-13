import type { NextRequest } from "next/server";
import { ApiError, handleApiError, ok, parseJson } from "@/lib/api";
import { requireModule, requireSuperadmin } from "@/lib/auth/guards";
import { hashPassword } from "@/lib/auth/hash";
import { connectDB } from "@/lib/db";
import { createUserSchema } from "@/lib/validation/admin";
import { User } from "@/models/User";

export async function GET() {
  try {
    await requireModule("admin");
    await connectDB();
    const usuarios = await User.find()
      .sort({ createdAt: -1 })
      .select({ passwordHash: 0, resetTokenHash: 0, resetTokenExpiresAt: 0 })
      .lean();
    return ok({
      usuarios: usuarios.map((u) => ({
        id: String(u._id),
        email: u.email,
        name: u.name,
        role: u.role,
        modules: u.modules.map(String),
        active: u.active,
        createdAt: new Date(u.createdAt).toISOString(),
      })),
    });
  } catch (e) {
    return handleApiError(e);
  }
}

// Los usuarios normales se crean desde aquí y se les asignan módulos
// explícitamente (§5.4). Solo superadmin puede gestionar usuarios.
export async function POST(request: NextRequest) {
  try {
    await requireSuperadmin();
    const body = await parseJson(request, createUserSchema);
    await connectDB();

    const existe = await User.findOne({ email: body.email.toLowerCase() }).lean();
    if (existe) throw new ApiError(409, "DUPLICADO", "Ya existe un usuario con ese correo");

    const user = await User.create({
      email: body.email.toLowerCase(),
      name: body.name,
      passwordHash: await hashPassword(body.password),
      role: "user",
      modules: body.modules,
      active: body.active,
    });
    return ok({ id: String(user._id) });
  } catch (e) {
    return handleApiError(e);
  }
}
