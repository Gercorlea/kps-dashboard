import { ApiError, handleApiError, ok } from "@/lib/api";
import { requireUser } from "@/lib/auth/guards";
import { connectDB } from "@/lib/db";
import { User } from "@/models/User";

// Hidrata la sesión en el cliente (§5.1).
export async function GET() {
  try {
    const session = await requireUser();
    await connectDB();
    const user = await User.findById(session.id).lean();
    if (!user || !user.active) {
      throw new ApiError(401, "NO_AUTENTICADO", "Usuario inactivo");
    }
    return ok({
      id: String(user._id),
      name: user.name,
      email: user.email,
      role: user.role,
      modules: user.modules.map(String),
    });
  } catch (e) {
    return handleApiError(e);
  }
}
