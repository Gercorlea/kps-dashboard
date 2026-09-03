import { NextResponse, type NextRequest } from "next/server";
import { verifyAccessToken } from "@/lib/auth/jwt";
import { ACCESS_COOKIE, REFRESH_COOKIE } from "@/lib/auth/cookies";

// Intercepción de request con la convención proxy de Next 16 (§5.3):
// SOLO un check optimista y ligero — leer la cookie del access token y
// verificar la firma con jose. La verificación pesada por módulo/recurso
// vive en cada route.ts y página, no aquí.
//
// RENOVACIÓN DE SESIÓN. El access dura 15 minutos y el refresh 30 días. Antes,
// al caducar el access esto mandaba al login sin llegar a mirar el refresh: el
// usuario veía la pantalla de login cada cuarto de hora estando activo, y solo
// recargando volvía —porque el reintento de api-client.ts sí refresca, pero
// únicamente para llamadas hechas desde el navegador, no para el render de las
// páginas en servidor—. Aquí se intenta la renovación antes de rendirse.
//
// La rotación no se hace en este archivo: vive en /api/auth/refresh, que es
// quien puede tocar Mongo y revocar el token anterior (§5.1). Ese endpoint está
// fuera del matcher, así que la subpetición NO vuelve a pasar por el proxy y no
// hay recursión.

const RUTAS_PUBLICAS = ["/login", "/recuperar", "/restablecer"];

// Lo que el refresco necesita del cliente original: la cookie para autenticar,
// y la IP para que el rate limit cuente por usuario y no por servidor —clientIp
// lee x-forwarded-for, y sin propagarla todos caerían en el mismo cubo—.
const CABECERAS_PROPAGADAS = ["cookie", "x-forwarded-for", "x-real-ip", "user-agent"];

/** Pide la rotación al endpoint que sí puede hacerla. `null` si no se pudo. */
async function renovarSesion(request: NextRequest): Promise<Response | null> {
  const headers = new Headers();
  for (const nombre of CABECERAS_PROPAGADAS) {
    const valor = request.headers.get(nombre);
    if (valor) headers.set(nombre, valor);
  }

  try {
    const res = await fetch(new URL("/api/auth/refresh", request.url), {
      method: "POST",
      headers,
      // Una rotación jamás puede servirse desde caché: devolvería un token ya
      // revocado y cerraría la sesión.
      cache: "no-store",
    });
    return res.ok ? res : null;
  } catch {
    // Si el refresco no responde, se cae al redirect de siempre. Es el mismo
    // comportamiento que había antes de existir esta función.
    return null;
  }
}

/** Valor de una cookie concreta dentro de las cabeceras Set-Cookie de `res`. */
function cookieDeRespuesta(res: Response, nombre: string): string | null {
  for (const cabecera of res.headers.getSetCookie()) {
    const par = cabecera.split(";")[0];
    const igual = par.indexOf("=");
    if (igual > 0 && par.slice(0, igual).trim() === nombre) {
      return par.slice(igual + 1);
    }
  }
  return null;
}

/**
 * Deja pasar la petición, arrastrando la sesión recién renovada si la hubo.
 *
 * Hay que hacer DOS cosas y ninguna sobra:
 *   - reescribir la cookie de la REQUEST, porque la página se renderiza con las
 *     cabeceras de entrada y sin esto el componente de servidor seguiría leyendo
 *     el access token caducado y respondería 401 igual que antes;
 *   - reenviar los Set-Cookie de la RESPUESTA, para que el navegador se quede
 *     con los tokens nuevos y no vuelva a renovar en la siguiente petición.
 */
function continuar(request: NextRequest, renovada: Response | null): NextResponse {
  if (!renovada) return NextResponse.next();

  const cookies = new Map(request.cookies.getAll().map((c) => [c.name, c.value]));
  for (const nombre of [ACCESS_COOKIE, REFRESH_COOKIE]) {
    const valor = cookieDeRespuesta(renovada, nombre);
    if (valor) cookies.set(nombre, valor);
  }

  const headers = new Headers(request.headers);
  headers.set(
    "cookie",
    Array.from(cookies, ([nombre, valor]) => `${nombre}=${valor}`).join("; ")
  );

  const res = NextResponse.next({ request: { headers } });
  for (const cabecera of renovada.headers.getSetCookie()) {
    res.headers.append("set-cookie", cabecera);
  }
  return res;
}

/**
 * Next dispara prefetch al pasar el ratón por encima de un enlace. Como cada
 * refresco ROTA el token y revoca el anterior, dos renovaciones simultáneas
 * dejarían a la segunda con un token ya revocado y cerrarían la sesión de
 * verdad. Un prefetch sin sesión se descarta solo; la navegación real que venga
 * después ya renovará.
 */
function esPrefetch(request: NextRequest): boolean {
  return (
    request.headers.get("next-router-prefetch") === "1" ||
    request.headers.get("purpose") === "prefetch"
  );
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const esApi = pathname.startsWith("/api");
  const esRutaPublica = RUTAS_PUBLICAS.some(
    (r) => pathname === r || pathname.startsWith(`${r}/`)
  );

  const token = request.cookies.get(ACCESS_COOKIE)?.value;
  let claims = token ? await verifyAccessToken(token) : null;

  if (esRutaPublica) {
    // Usuario ya autenticado en el login → directo al dashboard. Aquí no se
    // renueva: quien llega al login viene a identificarse, y renovarle la
    // sesión por detrás le impediría entrar como otro usuario.
    if (claims && pathname === "/login") {
      return NextResponse.redirect(new URL("/dashboard", request.url));
    }
    return NextResponse.next();
  }

  let renovada: Response | null = null;
  if (!claims && !esPrefetch(request) && request.cookies.get(REFRESH_COOKIE)) {
    renovada = await renovarSesion(request);
    if (renovada) {
      const nuevo = cookieDeRespuesta(renovada, ACCESS_COOKIE);
      claims = nuevo ? await verifyAccessToken(nuevo) : null;
      // Renovar y que el token nuevo no valide sería un fallo del emisor. Se
      // descarta la renovación entera en vez de dejar pasar sin sesión.
      if (!claims) renovada = null;
    }
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

  return continuar(request, renovada);
}

export const config = {
  matcher: [
    /*
     * Todo excepto:
     * - /api/auth (login/refresh/recuperar gestionan su propia auth; además, si
     *   /api/auth/refresh pasara por aquí, la renovación se llamaría a sí misma)
     * - /api/sap (integración del equipo en main; sin sesión de dashboard)
     * - /_next (estáticos e imágenes)
     * - archivos públicos con extensión (png, ico, svg…)
     */
    "/((?!api/auth|api/sap|_next/static|_next/image|favicon\\.ico|.*\\..*).*)",
    "/api/((?!auth|sap).*)",
  ],
};
