# Arquitectura — Cronos Retail

Dashboard-only (sin sitio público) de **Arcanum** con dos módulos visibles como
pestañas — **Retail** (`/retail`) y **KPS AI** (`/cronos-ia`) — más
administración (`/admin`). Las pestañas son **navegación real**: rutas
distintas, cada una con su guard de módulo; no son estado local de un
componente.

## Stack

Next.js (App Router, Next 16) · TypeScript strict · Tailwind v4 + CSS del
design system · MongoDB Atlas vía Mongoose (cache serverless)
· Resend · JWT propio con `jose` · Vercel AI
Gateway · SheetJS en el servidor · Vitest.

## Route groups

```
src/app/
  (app)/        dashboard autenticado — layout con Sidebar (verifica sesión)
    dashboard/  overview con KPIs, venta mensual por retailer y lista de retailers
    retail/     lista de retailers, [retailer]/ (ficha), analisis/
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

## Entrada de datos: el analizador

La vía de entrada es `/retail/analisis`: se sube un .xlsx, se parsea **en el
navegador**, se reconoce la plantilla (`lib/retail/analisis/plantillas.ts`) y al
guardar se elige el retailer. El servidor hace upsert por la clave natural
`(account, itemNbr, date)` en `salesreports`, así que volver a subir el mismo
reporte actualiza en vez de duplicar.

El Excel **no se almacena**: sólo viajan las filas ya mapeadas a campos.

Ese upsert sobrescribe `importedAt`/`importedBy`/`sourceFile` de cada fila, así
que la primera escritura se guarda aparte en
`firstImportedAt`/`firstImportedBy`/`firstSourceFile` con `$setOnInsert`. Como eso
sólo cubre las altas —y las filas guardadas antes de que los campos existieran se
ACTUALIZAN, no se insertan—, cada POST arranca con un `updateMany` que le copia a
esas filas la fecha y el autor que traen antes de pisárselos. Va en una orden aparte y no dentro del upsert de cada fila porque se
midió: resolverlo con un update de pipeline por fila obliga a envolver cada valor
en `$literal` (un texto que empieza por "$" se leería como referencia a un campo)
e infla el comando un 46%, que sobre un enlace de ~110 KB/s son 80 → 150 s por
carga. Con eso, una fila con `importedAt > firstImportedAt` es
exactamente una fila que reescribió una carga posterior: de ahí salen el
"Importado" y la "Última actualización" que muestra la ficha del retailer, sin
que una carga partida en lotes de 2000 filas —cada uno con su marca de tiempo—
parezca una actualización.

`firstSourceFile` está por un segundo efecto de que la clave natural no incluya
el archivo: **dos reportes que se solapan comparten filas**. Si se sube feb-mar y
luego mar-abr, las filas de marzo pasan a llevar el `sourceFile` del segundo pero
conservan el `firstImportedAt` del primero. Agrupando por `sourceFile`, mar-abr
heredaba con ellas la fecha de carga de feb-mar y salía "importado" el día del
primero, con su fecha real abajo como si fuera una actualización. Por eso un
reporte se fecha por las filas que CREÓ (`firstSourceFile`) y se mide por las que
TIENE (`sourceFile`): "importado" es la primera escritura de lo que creó, y
"última actualización" es la última vez que alguien reescribió algo creado por
él —él mismo al volver a subirse, o la carga que se le llevó filas—.

`firstSourceFile` es el único de los tres que no se rescata hacia atrás: de una
fila anterior al campo que además ya reescribió otra carga, nadie guardó qué
archivo la creó. En vez de atribuírsela al que la tiene hoy —que es justo el
error— se deja sin atribuir y no fecha a nadie, así que el histórico que ya
estaba guardado también deja de mostrar la fecha equivocada. Lo único que no se
puede reconstruir de él es la "última actualización" del reporte al que le
quitaron filas antes de este cambio.

Los acumuladores y los dos pipelines viven en `lib/retail/importaciones.ts` para
que la lista de reportes y la ficha de un reporte
(`GET /api/retail/analisis/reporte`) cuenten lo mismo; `tests/importaciones.test.ts`
los ejercita contra un Mongo en memoria.

> El flujo anterior de ingesta por hojas fijas (`/retail/cargar`, el parser por
> hoja y el scorecard) se retiró: sus colecciones llevaban tiempo vacías —0
> documentos en ventas, inventarios, OC y pronósticos— y sólo sabía procesar San
> Pablo, porque estampaba `account: "san-pablo"` fijo en cada carga. Los modelos
> siguen declarados porque la herramienta de consulta de KPS AI aún los
> referencia.

## Lectura: agregar en Mongo, plegar en el navegador

Las vistas de retail (`/retail/[retailer]`, `/retail/analisis`) piden a
`GET /api/retail/analisis/resumen` un **bundle de acumuladores**: en un solo
`$facet`, la suma de todas las métricas para todas las dimensiones. El navegador
elige cuál mirar con los helpers de `lib/retail/analisis/agregar.ts`
(`acumuladoresDeGrupos` → `plegarTopN` / `rellenarSerie`), los mismos que corren
sobre un archivo recién subido.

Es una decisión medida, no una preferencia: traer las filas para agregarlas en
el navegador costaba 48 s (5.2 MB por un enlace a la base de ~110 KB/s), y
agregar en el servidor **por cada selección** metía un viaje en cada cambio de
filtro. El bundle son ~22 KB y un solo viaje. `alcance=cuenta` agrega todos los
reportes de un retailer; `alcance=archivo`, sólo el que se está viendo.

Que el plegado sea compartido es lo que evita que las dos vistas se
desincronicen; `tests/analisis-paridad.test.ts` fija esa frontera.

## Modelo de datos (colecciones e índices)

| Colección | Origen | Índices principales |
|---|---|---|
| `salesreports` | reportes del analizador | `{account, itemNbr, date}` unique · `{account, date:-1}` · `{sourceFile, date, itemNbr}` · `{importedAt:-1}` |
| `uploads` | metadatos por archivo (ingesta retirada) | `{fileHash}` unique parcial · `{cuenta, fechaCorte:-1}` · `{status}` |
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
| Reconocer un reporte nuevo | `src/lib/retail/analisis/plantillas.ts` (una `Plantilla` más) |
| Cambiar qué se agrega o cómo se pliega | `src/lib/retail/analisis/agregar.ts` (+ `tests/analisis-paridad.test.ts`) |
| Límites de rate limiting | `src/lib/rate-limit.ts` (`LIMITES`) |
| Módulos RBAC | `src/lib/rbac.ts` (`MODULES`) |
| Ventana de la gráfica del dashboard | `src/lib/retail/stats.ts` (`MESES_DASHBOARD`) |
| Retailers y su color en las gráficas | `src/lib/retail/retailers.ts` (`RETAILERS`, `colorRetailer`) |
| Prompt del asistente | `src/lib/ai.ts` (`SYSTEM_PROMPT`) |
| Tokens visuales | `src/app/design-system.css` (+ `lib/docs/DESIGN.md`) |
