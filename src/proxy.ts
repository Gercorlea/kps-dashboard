import { NextResponse, type NextRequest } from "next/server";
import { verifyAccessToken } from "@/lib/auth/jwt";
import { ACCESS_COOKIE } from "@/lib/auth/cookies";

// Intercepción de request con la convención proxy de Next 16 (§5.3):
// SOLO un check optimista y ligero — leer la cookie del access token y
// verificar la firma con jose. La verificación pesada por módulo/recurso
// vive en cada route.ts y página, no aquí.

const RUTAS_PUBLICAS = ["/login", "/recuperar", "/restablecer"];

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const esApi = pathname.startsWith("/api");
  const esRutaPublica = RUTAS_PUBLICAS.some(
    (r) => pathname === r || pathname.startsWith(`${r}/`)
  );

  const token = request.cookies.get(ACCESS_COOKIE)?.value;
  const claims = token ? await verifyAccessToken(token) : null;

  if (esRutaPublica) {
    // Usuario ya autenticado en el login → directo al dashboard.
    if (claims && pathname === "/login") {
      return NextResponse.redirect(new URL("/dashboard", request.url));
    }
    return NextResponse.next();
  }

  if (!claims) {
    if (esApi) {
      return NextResponse.json(
        { ok: false, error: { code: "NO_AUTENTICADO", message: "Sesión no válida o expirada" } },
        { status: 401 }
      );
    }
    const login = new URL("/login", request.url);
    if (pathname !== "/") login.searchParams.set("siguiente", pathname);
    return NextResponse.redirect(login);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    /*
     * Todo excepto:
     * - /api/auth (login/refresh/recuperar gestionan su propia auth)
     * - /api/sap (integración del equipo en main; sin sesión de dashboard)
     * - /_next (estáticos e imágenes)
     * - archivos públicos con extensión (png, ico, svg…)
     */
    "/((?!api/auth|api/sap|_next/static|_next/image|favicon\\.ico|.*\\..*).*)",
    "/api/((?!auth|sap).*)",
  ],
};
