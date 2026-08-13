# Arquitectura — Cronos Retail

Dashboard-only (sin sitio público) de **Arcanum** con dos módulos visibles como
pestañas — **Retail** (`/retail`) y **KPS AI** (`/cronos-ia`) — más
administración (`/admin`). Las pestañas son **navegación real**: rutas
distintas, cada una con su guard de módulo; no son estado local de un
componente.

## Stack

Next.js (App Router, Next 16) · TypeScript strict · Tailwind v4 + CSS del
design system · MongoDB Atlas vía Mongoose (cache serverless) · Cloudflare R2
(S3-compatible, presigned URLs) · Resend · JWT propio con `jose` · Vercel AI
Gateway · SheetJS en el servidor · Vitest.

## Route groups

```
src/app/
  (app)/        dashboard autenticado — layout con Sidebar (verifica sesión)
    dashboard/  overview con KPIs
    retail/     listado, cargar/, [uploadId]/ (detalle + scorecard/), historico/
    cronos-ia/  chat
    admin/      usuarios/, estadisticas/
  (auth)/       login/, recuperar/, restablecer/[token]/
  api/          auth/, retail/, ai/, admin/, sap/ (integración del equipo)
src/proxy.ts    intercepción global (convención proxy de Next 16)
```

## Flujo de autenticación

1. `POST /api/auth/login` valida credenciales (bcrypt cost 12), lee el usuario
   con `.lean()` y emite **access token** (15 min) + **refresh token** (30 días,
   con `jti`) firmados con `jose` HS256, en cookies httpOnly.
2. En DB solo se guarda el **hash sha256 del refresh** (`RefreshToken`), lo que
   permite revocar en logout, cambio de contraseña o expulsión.
3. `POST /api/auth/refresh` **rota**: revoca el refresh usado y emite uno nuevo.
4. `src/proxy.ts` hace el **check optimista** (firma del access token). La
   verificación por módulo vive en cada `route.ts` y página:
   `requireModule("retail")` → 401/403 del contrato de API.
   Archivos: `src/lib/auth/{jwt,cookies,hash,guards,session}.ts`.

## Flujo de ingesta de Excel

1. `POST /api/retail/uploads` valida con Zod (extensión, MIME, ≤25 MB), crea el
   `Upload` en `pendiente` y devuelve un **presigned PUT** a R2
   (`private/retail/<uploadId>/<archivo>`; los Excel son confidenciales).
2. El navegador sube directo a R2 (barra de progreso).
3. La UI muestra la **fecha de corte derivada del nombre** (editable, requerida)
   y las hojas detectadas; al confirmar, `POST /api/retail/uploads/[id]/process`
   (runtime nodejs, `maxDuration 300`).
4. El servidor descarga de R2, calcula **sha256** (duplicado → `409` con el
   `uploadId` existente), parsea hoja por hoja (`lib/retail/parse-workbook.ts`),
   **borra las filas previas del upload** (reproceso idempotente) e inserta con
   `bulkWrite` en lotes de 3,000. El avance por hoja se escribe en
   `Upload.resumen` y la UI lo muestra por polling.

### Decisión clave: almacenamiento en formato largo (long), no ancho

Los Excel traen las fechas **como columnas** (`05.05.2026`, …) y ese set cambia
cada semana. Guardar columnas tal cual exigiría migrar el esquema semana a
semana y ninguna query histórica sería posible. Por eso **cada columna de fecha
se desnormaliza (unpivot) a documentos individuales** `{ …dimensiones, fecha,
valor }`. Es lo que habilita el comparativo año contra año y las series del
histórico. (Ver `lib/retail/parse-workbook.ts`.)

Trampas del archivo real blindadas en el parser (todas con test):
pivots pegados a la derecha (el ancho real es la fila 1 hasta la primera celda
vacía), fechas `Date` vs `dd.mm.yyyy` (parseo manual — `new Date("13.05.2026")`
es Invalid Date), encabezados con espacio final, `Fecha de entrega <Mes>` por
prefijo, códigos con ceros a la izquierda (`0141`; SKU siempre string), filas
vacías al final, `Total`/`Total red` excluidos, marca derivada por catálogo
ordenado (`lib/retail/brands.ts`) con `SIN CLASIFICAR` visible en la UI.

## Modelo de datos (colecciones e índices)

| Colección | Origen | Índices principales |
|---|---|---|
| `uploads` | metadatos por archivo | `{fileHash}` unique sparse · `{cuenta, fechaCorte:-1}` · `{status}` |
| `ventadiarias` | VENTAS (unpivot) | `{cuenta, fecha:-1, sku}` · `{uploadId}` · `{cuenta, marca, fecha:-1}` |
| `pronosticosemanals` | PRONOSTICOS (unpivot) | `{cuenta, semanaInicio:-1, sku}` · `{uploadId}` |
| `forecastdiarios` | FC_Mean (unpivot) | `{cuenta, fecha:-1, sku}` · `{uploadId}` |
| `stockcedis` | CEDIS (citas embebidas) | `{cuenta, fechaCorte:-1, sku}` · `{uploadId}` |
| `stockfarmacias` | Inv Farma | `{cuenta, fechaCorte:-1, sku}` · `{uploadId}` · `{cuenta, fechaCorte:-1, marca}` |
| `lineaocs` | Fill Rate | `{cuenta, fechaCorte:-1}` · `{uploadId}` · `{cuenta, fechaCorte:-1, negociador}` |
| `users`, `refreshtokens` (TTL), `ratelimits` (TTL), `chats`, `mensajes` | sistema | TTL en `expiresAt` |

Todos los modelos usan el guard `mongoose.models.X ?? mongoose.model(...)`, los
índices se declaran en el schema y `findOneAndUpdate` usa
`{ returnDocument: "after" }` (nunca `{ new: true }`).

## Scorecard

`lib/retail/scorecard.ts` — `GET /api/retail/scorecard?cuenta=san-pablo&hasta=…`.
Reporte **calculado** con agregaciones sobre las colecciones persistidas:
bloques Mes / Marca / Top productos / Tiendas / Fill rate, todos con
`Inc vs AA = actual/anterior − 1` (divisor 0 o sin dato → `—`, nunca ∞) y
`MOH = inventario / unidades del mes` (en bloques no mensuales, las unidades
del mes son el promedio mensual del período). El inventario suma
`StockFarmacia.libreUtilizacion + transitoFarma` y
`StockCedis.disponibilidadRealCD` al corte. La **narrativa** se genera por
plantilla determinista desde los números calculados — nunca con el LLM. La
cobertura (rango, cortes, meses completos vs parciales) se muestra en el
encabezado; sin histórico del año anterior el bloque lleva el badge
"Sin histórico comparable".

v1 cubre **solo San Pablo**; `cuenta` queda en el modelo y el selector listo
para más cuentas (Walmart no tiene fuente de datos todavía). El bloque de
tiendas sustituye al de "Formato" (San Pablo no trae formato de tienda).

## KPS AI

Módulo independiente: **no recibe datos de Retail**. `lib/ai.ts` es el único
punto de acceso a modelos, vía **Vercel AI Gateway**
(`anthropic/claude-sonnet-4.6`, `only: ["anthropic"]` + `zeroDataRetention:
true` — la request falla antes que enrutarse sin acuerdo ZDR). Historial en
`chats`/`mensajes` scopeado por usuario con ownership verificada por request;
streaming con el AI SDK (`toUIMessageStreamResponse`); rate limiting en el
endpoint.

## Integración SAP (rama main del equipo)

`src/lib/sap/service-layer.ts` + `GET /api/sap/ping` viven fuera de los módulos
del dashboard; el proxy los excluye del guard de sesión para no cambiar su
comportamiento original.

## Dónde tocar qué

| Cambio | Archivo |
|---|---|
| Agregar una marca | `src/lib/retail/brands.ts` (una línea en `MARCAS`) |
| Mapear una columna nueva | `src/lib/retail/parse-workbook.ts` (mapa de la hoja) |
| Un bloque más del scorecard | `src/lib/retail/scorecard.ts` |
| Límites de rate limiting | `src/lib/rate-limit.ts` (`LIMITES`) |
| Módulos RBAC | `src/lib/rbac.ts` (`MODULES`) |
| Umbral de MOH del dashboard | `src/lib/retail/stats.ts` (`UMBRAL_MOH`) |
| Prompt del asistente | `src/lib/ai.ts` (`SYSTEM_PROMPT`) |
| Tokens visuales | `src/app/design-system.css` (+ `lib/docs/DESIGN.md`) |
