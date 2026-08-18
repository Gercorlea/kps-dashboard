"use client";

// Piezas compartidas de las gráficas de retail: la configuración de los ejes,
// la caja del tooltip, la leyenda y el badge de variación.
//
// Vive aparte de los componentes de gráfica porque las dos rutas que dibujan
// —/retail y /retail/[retailer]— tienen que verse IGUAL: mismos ejes, mismo
// tooltip, misma leyenda. Antes cada archivo repetía su propia constante
// `ejes` y su propio `contentStyle`, y bastaba tocar uno para que las dos
// páginas dejaran de hablar el mismo idioma.
//
// Nada de esto calcula: recibe texto ya formateado por el llamador, que es
// quien sabe si la métrica es dinero o unidades.

import type { ReactNode } from "react";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";

// Cromo de la gráfica. Todo sale de los tokens del design system: la rejilla es
// la línea más suave que hay y las etiquetas van en tinta 3, para que el dato
// —lo único con color de paleta— sea lo que pesa.
export const VIZ_GRID = "var(--cr-line-soft)";
export const VIZ_LABEL = "var(--cr-ink-3)";
export const VIZ_SUPERFICIE = "var(--cr-surface)";

/**
 * Duración de la animación de entrada. Corta a propósito: la gráfica se
 * redibuja cada vez que se cambia de métrica o de dimensión, y una animación
 * larga convierte un cambio de filtro en una espera.
 */
export const VIZ_ANIM = 420;

/**
 * Eje de valores: mono 10px en tinta 3. Sin línea de eje ni marcas —la rejilla
 * ya sitúa el valor y el eje dibujado solo agrega tinta que no es dato.
 */
export const ejeValor = {
  tick: { fontSize: 10, fill: VIZ_LABEL, fontFamily: "var(--cr-font-mono)" },
  axisLine: false,
  tickLine: false,
  stroke: VIZ_GRID,
} as const;

/**
 * Eje de categorías: nombres de producto, de marca o de tienda. Van en sans y
 * en tinta 2 porque son palabras, no cifras; la mono a 10px las vuelve un
 * trabalenguas.
 */
export const ejeCategoria = {
  tick: { fontSize: 11, fill: "var(--cr-ink-2)", fontFamily: "var(--cr-font-sans)" },
  axisLine: false,
  tickLine: false,
  stroke: VIZ_GRID,
} as const;

/** Cursor del tooltip en gráficas de línea: una guía vertical, no un bloque. */
export const CURSOR_LINEA = { stroke: "var(--cr-line-2)", strokeWidth: 1 };

/** Cursor del tooltip en gráficas de barra: la banda de la categoría. */
export const CURSOR_BANDA = { fill: "var(--cr-surface-3)" };

/** Recharts tipa lo que pasa a los formatters como `unknown` útil. */
export function comoNumero(v: unknown): number {
  return typeof v === "number" ? v : Number(v);
}

export function comoTexto(v: unknown): string {
  return v === null || v === undefined ? "" : String(v);
}

export function acortar(texto: string, max = 18): string {
  return texto.length > max ? `${texto.slice(0, max - 1)}…` : texto;
}

/** Una fila del tooltip o de la leyenda: color, nombre, cifra y, si toca, nota. */
export interface FilaViz {
  clave: string;
  etiqueta: string;
  /** Cifra ya formateada. Vacía en la leyenda de una serie sin datos. */
  valor?: string;
  color?: string;
  /** Segunda cifra, más apagada: la participación, el conteo de grupos… */
  nota?: string;
  /** En la leyenda: no se puede aislar (una serie sin datos que aislar). */
  inerte?: boolean;
}

function Punto({ color }: { color?: string }) {
  if (!color) return null;
  return <span aria-hidden="true" className="cr-viz-punto" style={{ background: color }} />;
}

/**
 * Caja del tooltip. Se arma desde el punto de datos y no desde el `payload` de
 * recharts: así el orden de las filas lo manda el llamador (el mismo de la
 * leyenda) y no el orden en que la librería registró las series.
 */
export function CajaTooltip({
  titulo,
  filas,
  total,
}: {
  titulo?: ReactNode;
  filas: FilaViz[];
  /** Fila separada bajo una línea: el total del periodo, normalmente. */
  total?: FilaViz;
}) {
  if (filas.length === 0) return null;
  return (
    <div className="cr-viz-tip">
      {titulo ? <div className="cr-viz-tip__titulo">{titulo}</div> : null}
      {filas.map((f) => (
        <div key={f.clave} className="cr-viz-tip__fila">
          <Punto color={f.color} />
          <span className="cr-viz-tip__nombre">{f.etiqueta}</span>
          {f.nota ? <span className="cr-viz-tip__nota">{f.nota}</span> : null}
          <span className="cr-viz-tip__valor">{f.valor}</span>
        </div>
      ))}
      {total ? (
        <div className="cr-viz-tip__fila cr-viz-tip__total">
          <span className="cr-viz-tip__nombre">{total.etiqueta}</span>
          <span className="cr-viz-tip__valor">{total.valor}</span>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Leyenda en HTML plano y no el `<Legend>` de recharts: la versión 3 quitó la
 * prop `payload`, así que la librería ordena las series alfabéticamente y no
 * hay forma de fijar el orden — la leyenda dejaba de coincidir con el orden de
 * los segmentos.
 *
 * Con `onFijar` los ítems son botones que aíslan una serie; sin él son texto.
 * El clic fija el foco y el puntero solo lo asoma, que son dos estados
 * distintos: pasar por encima de otra serie y salir devuelve a la fijada en vez
 * de perderla.
 *
 * El nombre va SIEMPRE en tinta: el cuadrito ya lleva la identidad, y un
 * amarillo de la paleta es ilegible como letra sobre blanco.
 */
export function Leyenda({
  items,
  foco = null,
  onFijar,
  onAsomar,
}: {
  items: FilaViz[];
  /** Clave aislada; el resto se apaga. */
  foco?: string | null;
  /** Si se pasa, cada ítem se vuelve botón. */
  onFijar?: (clave: string | null) => void;
  onAsomar?: (clave: string | null) => void;
}) {
  return (
    <ul className="cr-viz-leyenda">
      {items.map((item) => {
        const activo = foco === item.clave;
        const apagado = foco !== null && !activo;
        const clases = `cr-viz-leyenda__item${activo ? " cr-viz-leyenda__item--activo" : ""}${
          apagado ? " cr-viz-leyenda__item--apagado" : ""
        }`;
        const cuerpo = (
          <>
            <Punto color={item.color} />
            <span className="cr-viz-leyenda__nombre">{item.etiqueta}</span>
            {item.valor ? <span className="cr-viz-leyenda__nota">{item.valor}</span> : null}
            {item.nota ? <span className="cr-viz-leyenda__nota">{item.nota}</span> : null}
          </>
        );

        return (
          <li key={item.clave}>
            {onFijar && !item.inerte ? (
              <button
                type="button"
                className={clases}
                aria-pressed={activo}
                onClick={() => onFijar(activo ? null : item.clave)}
                onMouseEnter={() => onAsomar?.(item.clave)}
                onMouseLeave={() => onAsomar?.(null)}
                onFocus={() => onAsomar?.(item.clave)}
                onBlur={() => onAsomar?.(null)}
              >
                {cuerpo}
              </button>
            ) : (
              <span className={clases}>{cuerpo}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Variación con signo y flecha. El color dice el sentido —verde sube, rojo
 * baja— y la flecha lo repite, para no depender solo del color.
 */
export function Delta({ fraccion, texto }: { fraccion: number | null; texto: string }) {
  const tono = fraccion === null || fraccion === 0 ? "neutro" : fraccion > 0 ? "sube" : "baja";
  const Icono = tono === "sube" ? ArrowUpRight : tono === "baja" ? ArrowDownRight : Minus;
  return (
    <span className={`cr-viz-delta cr-viz-delta--${tono}`}>
      <Icono strokeWidth={2.25} aria-hidden="true" />
      {texto}
    </span>
  );
}

/**
 * Degradado vertical de una serie, para el relleno bajo una línea: el color a
 * un 18% arriba y transparente abajo. Es un lavado, nunca un bloque.
 */
export function DegradadoArea({ id, color }: { id: string; color: string }) {
  return (
    <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stopColor={color} stopOpacity={0.18} />
      <stop offset="100%" stopColor={color} stopOpacity={0} />
    </linearGradient>
  );
}

/**
 * Degradado de una barra: el mismo color con una caída de opacidad muy corta.
 * Va en el sentido de la barra y en coordenadas de la propia barra, así que
 * TODAS se ven igual — el degradado no codifica el valor, solo le quita
 * planitud al bloque.
 */
export function DegradadoBarra({
  id,
  color,
  horizontal = false,
}: {
  id: string;
  color: string;
  horizontal?: boolean;
}) {
  return (
    <linearGradient
      id={id}
      x1="0"
      y1="0"
      x2={horizontal ? "1" : "0"}
      y2={horizontal ? "0" : "1"}
    >
      <stop offset="0%" stopColor={color} stopOpacity={1} />
      <stop offset="100%" stopColor={color} stopOpacity={0.72} />
    </linearGradient>
  );
}
