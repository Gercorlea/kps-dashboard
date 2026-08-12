import { cookies } from "next/headers";
import { ACCESS_TTL_MIN, REFRESH_TTL_DIAS } from "@/lib/auth/jwt";

// Cookies httpOnly (§5.1): secure en producción, sameSite lax, path "/".

export const ACCESS_COOKIE = "cr_access";
export const REFRESH_COOKIE = "cr_refresh";

const baseOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
};

export async function setSessionCookies(accessToken: string, refreshToken: string) {
  const store = await cookies();
  store.set(ACCESS_COOKIE, accessToken, {
    ...baseOptions,
    maxAge: ACCESS_TTL_MIN * 60,
  });
  store.set(REFRESH_COOKIE, refreshToken, {
    ...baseOptions,
    maxAge: REFRESH_TTL_DIAS * 24 * 60 * 60,
  });
}

export async function clearSessionCookies() {
  const store = await cookies();
  store.set(ACCESS_COOKIE, "", { ...baseOptions, maxAge: 0 });
  store.set(REFRESH_COOKIE, "", { ...baseOptions, maxAge: 0 });
}
