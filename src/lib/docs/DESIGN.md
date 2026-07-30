# Diseño — sistema de dashboards Arcanum

Look **enterprise, denso en datos, preciso y sobrio**: fondos blancos, grises
secundarios, tinta casi negra, bordes cuadrados, tablas extensas, KPIs
compactos. No es un SaaS genérico redondeado ni glassmorphism; es más cercano a
un panel de control industrial / ERP moderno. La app es **light-first**.

Los tokens canónicos viven en `src/app/design-system.css` (variables `--cr-*`)
y el theme de Tailwind v4 en `globals.css`. **No cambiar valores sin actualizar
este documento.**

## Filosofía

1. **Bordes cuadrados**: radios de 2–4px casi en todo; `999px` solo para pills.
2. **Blanco + gris + tinta**: contenido sobre `#FFFFFF`; fondos secundarios
   `#FAFAF9` / `#F4F4F1`; canvas exterior `#D9D9D5`.
3. **Tinta `#15171C` como acción principal**: botones primarios, tabs activos,
   barras. Nada de azul corporativo.
4. **Morado `#5B3DF5` SOLO para Cronos IA** (link del sidebar, botones AI,
   badges AI, mensajes del assistant). Retail, Admin y Dashboard no lo usan.
5. **Datos primero**: tablas anchas, números en mono con `tabular-nums`
   alineados a la derecha, headers de tabla y labels en **mono uppercase
   9–10px gris**.
6. **Sombras mínimas**: `border + fondo plano`; elevación solo `--cr-shadow-1`.
7. **Transiciones de 120ms**; animación solo para estados live (spinner, pulse).

## Tipografía

- Sans: **Hanken Grotesk** (400/500/600/800) — UI general.
- Mono: **IBM Plex Mono** (400/500/600) — labels, tablas, métricas, códigos.
- Ambas se cargan con `next/font` en `app/layout.tsx`.
- Escala: H1 26px/600 · H2 19px/600 · H3 14px/600 · Body 13.5px ·
  Small 12px · Label 9.5px mono uppercase 0.12em · Métrica 27–30px/600.

## Componentes

Clases `.cr-*` en `design-system.css`: `cr-btn` (primary/secondary/ai/ghost/sm),
`cr-input`, `cr-segment` (las pestañas Retail | Cronos IA), `cr-panel`/`cr-card`,
`cr-kpi` (línea superior de 2px; roja si alerta), `cr-badge` (ok/warn/danger/ai),
`cr-table` (+ `.num`, columnas sticky de SKU/descripción en desktop),
`cr-meter`, shell (`cr-sidebar`, `cr-navlink`, `cr-page-head`,
`cr-page-content`), chat (`cr-msg-user`, `cr-msg-assistant`, `cr-chat-send`).

Toda tabla va envuelta en un `.cr-panel` con scroll interno (`cr-table-scroll`).

## Marca

Los 5 PNG de `public/` son de la marca **Arcanum** (no de un cliente) y se dan
por hechos — no se generan ni se sustituyen:

| Archivo | Uso | Fondo |
|---|---|---|
| `ArcanumBlackLogo.png` | isotipo tinta | claro |
| `ArcanumWhiteLogo.png` | isotipo blanco | oscuro |
| `ArcanumTextBlack.png` | logotipo tinta | claro |
| `ArcanumTextWhite.png` | logotipo blanco | oscuro |
| `ArcanumFavicon.png` | favicon / app icon | — |

Regla única de contraste: **Black sobre claro, White sobre oscuro, nunca al
revés**. Isotipo para espacios cuadrados (sidebar colapsado, estados vacíos,
spinners, avatar del producto); logotipo cuando hay ancho. Siempre a través de
`components/ui/BrandMark.tsx` — no hardcodear rutas de imagen. El favicon se
registra en `metadata.icons`. **Nunca** un emoji, una inicial o un ícono Lucide
como marca.

## Iconografía

Lucide React, stroke 1.5–1.75. Solo navegación, acciones y estados. Tamaños:
14px en botones, 15px en sidebar, 16–20px en headers de card.

## Semántica de color

| Estado | Color | Uso |
|---|---|---|
| OK | `#1F9468` | carga procesada, fill rate ≥ meta |
| Atención | `#B9791C` | en proceso, marcas sin clasificar, MOH alto |
| Error | `#CF4733` | carga fallida, filas rechazadas, MOH > umbral |
| Primario | `#15171C` | tabs, botones, barras |
| IA | `#5B3DF5` | exclusivo Cronos IA |

## Responsive

- < 1024px: sidebar → mobile nav fija de 56px + drawer con backdrop
  `rgba(10,12,18,0.32)`; sticky de tablas desactivado; grids a 1 columna;
  chat a pantalla completa con sidebar como overlay.
- Padding de contenido: 16px móvil → 24px tablet → 40px desktop.

## Anti-patrones (si aparece alguno, está mal)

`border-radius` 8/12/16px en cards o botones · gradientes/glass/neumorphism ·
azul `#3B82F6` primario · morado fuera de Cronos IA · `shadow-xl` ·
Inter/Roboto o datos sin mono · dark mode por defecto · espaciado de landing ·
headers de tabla en sans normal · emojis o iconos genéricos como marca.
