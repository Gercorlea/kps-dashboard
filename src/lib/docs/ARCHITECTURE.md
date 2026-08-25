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

### Un registro puede estar en dos reportes

La clave natural **no incluye el archivo**, y eso tiene una consecuencia: dos
reportes que se solapan —feb-mar y luego mar-abr— **comparten** las filas de
marzo. Es una relación de muchos a muchos, y por eso la procedencia de una fila
es un **conjunto**, `sourceFiles`, que el upsert acumula con `$addToSet` en vez
de pisar con `$set`.

Las dos mitades del update dicen cosas distintas a propósito:

- **`$set`** — las métricas las gana la última carga. Si dos archivos traen el
  mismo registro con cifras distintas, quedan las del más reciente.
- **`$addToSet`** — la procedencia no se pisa. Los dos reportes muestran la fila
  como suya y el documento sigue siendo **uno solo**, así que ninguna agregación
  por cuenta —las gráficas— la cuenta dos veces.

En la ficha del retailer eso se ve en la columna *Filas* de "Reportes
guardados": la suma de la columna es **mayor** que el total del histórico, y es
correcto. Se calcula con un `$unwind` sobre `sourceFiles`
(`lib/retail/importaciones.ts`).

Antes la procedencia era un escalar y el segundo reporte le **quitaba** las
filas al primero: desaparecían de su conteo, de su periodo y de sus totales, y
su botón de borrar se llevaba filas ajenas. De ahí venía todo el andamiaje de
`firstSourceFile` / `firstImportedAt` y el `$facet` de dos ramas que intentaba
adivinar qué carga había creado cada fila —algo que, para una fila ya
reescrita, nadie había guardado nunca—. Con la membresía acumulada esa pregunta
deja de tener uso y el andamiaje entero desaparece.

Borrar un reporte deja de ser `deleteMany`: se van las filas cuyo **único**
dueño es él (`sourceFiles: [archivo]`, igualdad contra el arreglo completo) y
las compartidas sólo pierden la membresía (`$pull`). En ese orden, para no dejar
ni un instante filas con `sourceFiles: []` que las gráficas seguirían sumando.

### Las fechas son del reporte, no de sus filas

Cuándo se importó un reporte y quién lo subió vive en `reportimports`
(`models/ReportImport.ts`), un documento por `(account, sourceFile)`. Las filas
dicen **qué** hay; ese documento dice **cuándo** y **quién**. Con eso la lista de
"Reportes guardados" es un `find` sobre unas decenas de documentos indexados en
vez de una agregación sobre las ~15,000 filas de la cuenta, y `stats.ts` deja de
reunir los `sourceFile` distintos del histórico entero para contar reportes.

Una carga viaja en lotes de 2000 filas y cada lote es un POST suelto, así que el
cliente genera un **id de carga** (`carga`) y lo manda en todos. Sin él, el
segundo lote de una primera subida vería el documento que dejó el primero y
marcaría el reporte como actualizado el mismo día en que se importó. "El
documento lo dejó otra carga" es exactamente "el reporte se volvió a subir".

> Queda fuera un caso que ya se comportaba así antes: volver a subir un archivo
> con **menos** filas no le quita la membresía a las que ya no trae. La salida es
> borrar el reporte y volver a subirlo, que ahora sí es seguro para el reporte
> que se solapa con él.

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
| `salesreports` | reportes del analizador | `{account, itemNbr, date}` unique · `{account, date:-1}` · `{account, brand, date:-1}` · `{account, sourceFiles, date, itemNbr}` (multikey) · `{importedAt:-1}` |
| `reportimports` | un documento por archivo cargado | `{account, sourceFile}` unique · `{account, lastWriteAt:-1}` · `{account, importedAt:-1}` |
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
