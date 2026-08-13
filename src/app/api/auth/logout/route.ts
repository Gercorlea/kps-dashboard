import type { NextRequest } from "next/server";
import { handleApiError, ok } from "@/lib/api";
import { REFRESH_COOKIE, clearSessionCookies } from "@/lib/auth/cookies";
import { revocarRefreshPorToken } from "@/lib/auth/session";
import { connectDB } from "@/lib/db";

export async function POST(request: NextRequest) {
  try {
    const refresh = request.cookies.get(REFRESH_COOKIE)?.value;
    if (refresh) {
      await connectDB();
      await revocarRefreshPorToken(refresh);
    }
    await clearSessionCookies();
    return ok({ sesionCerrada: true });
  } catch (e) {
    return handleApiError(e);
  }
}
