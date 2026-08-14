# Seguridad — Cronos Retail

## Autenticación

- JWT propio firmado con **`jose`** (HS256) — funciona en edge y Node, por eso
  no se usa `jsonwebtoken`. Access token ~15 min con claims `sub`, `role`,
  `modules` (**solo JSON plano**: `ObjectId → String`, arrays planos; el
  usuario se lee con `.lean()` antes de armar claims — evita `DataCloneError`).
- Refresh token ~30 días con **rotación en cada refresh**; en DB solo el hash
  sha256 (`refreshtokens`, TTL) → revocable en logout, cambio de contraseña,
  desactivación o "revocar sesiones" del admin.
- Cookies `httpOnly`, `secure` en producción, `sameSite: "lax"`, `path: "/"`.
- Contraseñas con **bcrypt cost 12**. Recuperación por Resend con token de un
  solo uso (hash en DB) y expiración de 30 min; al restablecer se revocan todas
  las sesiones.

## proxy.ts y doble capa de protección

Next 16 renombró `middleware` → **`proxy`** (`src/proxy.ts`, export
`function proxy(request)`). Ahí vive **solo el check optimista**: verificar la
firma del access token y redirigir a `/login` (páginas) o responder 401 (API).
`/api/auth/*` y `/api/sap/*` quedan fuera del matcher (el primero gestiona su
propia auth; el segundo es la integración del equipo y conserva su
comportamiento original).

La **seguridad real** está en la segunda capa: cada `route.ts` y cada página de
módulo llama a `requireModule("<módulo>")` / `requireSuperadmin()`
(`src/lib/auth/guards.ts`). Un usuario sin el módulo `retail` recibe **403** al
pegarle directo a `/api/retail/uploads`, tenga o no el link en el sidebar.

## RBAC

- `superadmin`: acceso total; se crea una sola vez con `npm run seed:superadmin`
  (lee credenciales de env, falla si ya existe).
- `user`: accede solo a los módulos asignados (`retail`, `cronos-ia`, `admin`).
- Gestión de usuarios (`/api/admin/usuarios*`): **solo superadmin** muta; el
  módulo `admin` da lectura de usuarios y estadísticas.
- El menú se renderiza según módulos, pero eso es UX, no seguridad.
- Nota operativa: los claims viven en el access token (15 min); desactivar un
  usuario revoca sus refresh, así que el acceso muere al expirar el access.

## Rate limiting

`src/lib/rate-limit.ts` — colección `ratelimits` con **índice TTL** (sin
Upstash/Redis). Límites centralizados y aplicados en: login, refresh,
recuperación, creación de cargas, procesamiento de Excel y chat de IA (los dos
últimos cuestan dinero y CPU). Al exceder: `429` con `reintentarEnSeg`.

## Archivos de carga — no se almacenan

- El Excel **nunca se guarda**: viaja en el POST de procesado, se parsea en
  memoria y se descarta. En la base quedan solo las filas.
- Tope de 25 MB validado en el cliente y en el servidor (413 si se excede).
- Al no existir copia del original, no hay URLs firmadas, ni objetos huérfanos,
  ni credenciales de almacenamiento que rotar.
- Reprocesar una carga exige volver a subir el archivo.

## Headers y CSP

`next.config.ts` aplica a todas las rutas: `Strict-Transport-Security` (prod),
`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`,
`Permissions-Policy` y una **CSP** (`default-src 'self'`; `connect-src` incluye
`frame-ancestors 'none'`).

## CSRF

Cookies `SameSite=Lax` + API same-origin + navegadores modernos → riesgo bajo:
los POST cross-site no llevan la cookie. Las mutaciones sensibles quedan además
detrás de rate limiting y RBAC. Si se agregara un dominio embebido o se
relajara SameSite, añadir token double-submit en las mutaciones.

## Variables sensibles

`MONGODB_URI`, `JWT_SECRET`, `JWT_REFRESH_SECRET`,
`RESEND_API_KEY`, `AI_GATEWAY_API_KEY`, credenciales SAP y seed del superadmin:
solo en `.env.local` / variables de Vercel. Nunca en el cliente ni en el repo
(el hook de pre-commit bloquea archivos .env). Los errores de API nunca filtran
stack traces (`handleApiError`).
