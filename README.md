# Cronos Retail — Arcanum

Dashboard **enterprise** para el histórico comercial de retail: ingesta de los
Excel semanales de la comercializadora a **MongoDB** (formato largo), tablas
densas por hoja, **Scorecard generado** de la cuenta San Pablo, serie
histórica multi-corte y **Cronos IA**, un chat independiente vía Vercel AI
Gateway. Sin sitio público y sin pagos. (El repo también contiene la
integración SAP Service Layer del equipo en `/api/sap`.)

| Pestaña | Ruta | Qué hace |
|---|---|---|
| **Retail** | `/retail` | subir/procesar los Excel, histórico y scorecard |
| **Cronos IA** | `/cronos-ia` | chat con LLM (módulo independiente, sin datos de Retail) |
| Admin | `/admin` | usuarios, permisos por módulo y estadísticas |

## Documentación

| Documento | Contenido |
|---|---|
| [`src/lib/docs/ARCHITECTURE.md`](src/lib/docs/ARCHITECTURE.md) | route groups, auth, ingesta, long vs wide, modelo de datos, scorecard, IA |
| [`src/lib/docs/SECURITY.md`](src/lib/docs/SECURITY.md) | JWT/`jose`, `proxy.ts`, doble capa, RBAC, rate limiting, headers/CSP, CSRF, R2 público vs confidencial |
| [`src/lib/docs/DEVELOPMENT.md`](src/lib/docs/DEVELOPMENT.md) | scripts, git, commits, testing, convenciones |
| [`src/lib/docs/DESIGN.md`](src/lib/docs/DESIGN.md) | design system Arcanum completo |
| [`src/lib/docs/PROMPTS.md`](src/lib/docs/PROMPTS.md) | declaración: sin medios generados con IA |
| [`.env.example`](.env.example) | todas las variables comentadas |

## Arranque local (mínimo)

```bash
cp .env.example .env.local     # 1) MONGODB_URI + JWT_SECRET + JWT_REFRESH_SECRET + SEED_*
npm install
npm run seed:superadmin        # 2) crea el superadmin (falla si ya existe)
npm run dev                    # 3) entra en http://localhost:3000 con el superadmin
```

R2, Resend y AI Gateway pueden configurarse después: sin R2 no hay subida de
Excel; sin Resend no hay correos; sin AI Gateway no responde el chat. El resto
de la app funciona.

---

## Guía de configuración de servicios (producción)

Orden sugerido: **Atlas → seed → Vercel → R2 → Resend → AI Gateway**.

### 1. MongoDB Atlas

**Qué es:** la base de datos de todo el sistema (usuarios, cargas, filas
históricas, chats, rate limiting).

1. Crea el cluster en [cloud.mongodb.com](https://cloud.mongodb.com) (M0 sirve
   para pruebas). En **Database Access** crea un usuario con lectura/escritura.
2. En **Network Access** agrega tu IP para local. Para Vercel: permite
   `0.0.0.0/0` (la seguridad real es la credencial + TLS) o IP allowlist con
   los rangos de Vercel si tu plan lo permite.
3. **Connect → Drivers** → copia la cadena `mongodb+srv://…` y ponle nombre de
   DB (p. ej. `/cronos-retail`).

Variables: `MONGODB_URI=mongodb+srv://usuario:pass@cluster…/cronos-retail`

**Verificar:** `npm run seed:superadmin` termina con `✔ Superadmin creado` y
puedes iniciar sesión.

### 2. Cloudflare R2 (lo que más se olvida)

**Qué es:** almacenamiento S3-compatible donde viven los Excel originales.
**Los Excel son confidenciales**: se sirven únicamente con **presigned GET de
vida corta** emitido por un endpoint autenticado — **nunca** por
`R2_PUBLIC_URL` (ver `SECURITY.md`).

1. En el dashboard de Cloudflare → **R2** → crea el bucket (p. ej.
   `cronos-retail`). Tu **Account ID** aparece en la barra lateral →
   `R2_ACCOUNT_ID`; el nombre del bucket → `R2_BUCKET`.
2. **R2 → Manage API Tokens → Create API Token** con permiso
   *Object Read & Write* sobre el bucket → copia **Access Key ID** →
   `R2_ACCESS_KEY_ID` y **Secret Access Key** → `R2_SECRET_ACCESS_KEY`.
3. **Acceso público**: solo si algún día se usa el prefijo `public/`
   (v1 no lo usa). Conecta un dominio público y ponlo en `R2_PUBLIC_URL`.
   **El resto del bucket queda privado.**
4. **CORS obligatorio** (sin esto las subidas directas desde el navegador
   fallan): bucket → *Settings* → *CORS Policy* y pega, sustituyendo
   `https://tu-dominio.com` por el dominio real en producción:

```json
[
  {
    "AllowedOrigins": ["https://tu-dominio.com", "http://localhost:3000"],
    "AllowedMethods": ["GET", "PUT", "HEAD"],
    "AllowedHeaders": ["Content-Type", "Content-Length", "Authorization"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

**Verificar:** sube un Excel desde `/retail/cargar`; confirma que
`https://<bucket-url>/private/retail/...` **no** abre (401/403) pero el botón
"Descargar original" **sí** descarga (presigned GET recién emitido).

### 3. Resend

**Qué es:** correo transaccional (recuperación de contraseña y resets desde
admin).

1. Crea cuenta en [resend.com](https://resend.com) → **Domains** → agrega tu
   dominio y crea los registros DNS (SPF/DKIM) hasta que verifique.
2. **API Keys** → crea una key → `RESEND_API_KEY`.
3. `EMAIL_FROM` debe ser un remitente del dominio verificado
   (p. ej. `Cronos Retail <no-reply@tu-dominio.com>`). En local puedes usar
   `onboarding@resend.dev` con envíos solo a tu propio correo.

**Verificar:** en `/recuperar` pide un enlace para un usuario real y confirma
que llega y restablece.

### 4. Vercel AI Gateway (Cronos IA)

**Qué es:** la puerta única a modelos para el chat. La app **no** instala SDKs
de proveedores: `lib/ai.ts` llama `anthropic/claude-sonnet-4.6` con
`only: ["anthropic"]` + `zeroDataRetention: true` (juntas a propósito: la
primera fija el proveedor sin fallback silencioso; la segunda hace que la
request **falle** si no hay credencial con acuerdo ZDR).

1. En Vercel → **AI Gateway** → crea una **API Key** → `AI_GATEWAY_API_KEY`
   (solo servidor, nunca en el cliente).
2. **Nota de plan:** el ZDR a nivel request **requiere plan Pro o Enterprise**.
   Verifica el plan de la cuenta antes de desplegar; adicionalmente puedes
   activar ZDR **team-wide** en AI Gateway → Settings (las dos vías se
   combinan como OR).
3. Confirma opciones vigentes en
   [vercel.com/docs/ai-gateway](https://vercel.com/docs/ai-gateway) y
   [provider options](https://vercel.com/docs/ai-gateway/models-and-providers/provider-options).

**Verificar:** en `/cronos-ia` crea una conversación y confirma respuesta en
streaming; en el dashboard del Gateway la request debe aparecer enrutada a
`anthropic`.

### 5. Deploy en Vercel

1. Importa el repo en Vercel (framework Next.js, sin configuración especial).
2. Carga **todas** las variables de `.env.example` en *Environment Variables*
   (Production y Preview). Diferencias local vs producción:
   `NEXT_PUBLIC_APP_URL` (dominio real), CORS de R2 (dominio real),
   `EMAIL_FROM` (dominio verificado).
3. Tras el primer deploy corre el seed apuntando a Atlas de producción
   (`npm run seed:superadmin` desde tu máquina con el `.env.local` de prod, una
   sola vez).
4. ⚠️ Esta rama usa **npm** (`package-lock.json`). Si en el repo conviven
   `pnpm-lock.yaml` y `package-lock.json`, Vercel elegirá pnpm: al hacer merge
   decidan un solo gestor y borren el lockfile del otro.

**Sin Stripe: este proyecto no tiene pagos.**

## Criterios rápidos de salud

```bash
npm test        # 44 tests: parser (6 trampas), marcas, guards, Zod, métricas
npm run build   # build de producción sin warnings de middleware/Mongoose
```
