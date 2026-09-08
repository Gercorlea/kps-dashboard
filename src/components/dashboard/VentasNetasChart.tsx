"use client";

// Gráfica de la portada: UNA línea con la venta neta de todos los retailers
// sumada, mes a mes, del año que se elija.
//
// No calcula la venta — recibe el histórico ya agregado por lib/retail/stats.ts,
// que es quien sabe que el dinero vive sólo en SalesReport. Lo único que hace
// aquí es rebanar ese histórico por año, y por eso el filtro no toca el
// servidor: los ~30 meses ya vinieron en el render de la página.
//
// Es dueña de su propio Panel porque el selector de año va en la cabecera y
// necesita el estado que vive aquí. Es lo mismo que hace AnalisisCharts en la
// ficha del retailer; la página se queda tan delgada como estaba.
//
// El cromo (ejes, tooltip, cursor) sale de components/retail/viz.tsx, el mismo
// de /retail y de la ficha: las tres rutas tienen que verse iguales.
//
// El color es TINTA y no un tono de --viz-*, y eso lo manda el design system:
// "resuelve las series con tinta/ok/danger, que alcanza para una serie sola
// pero no para distinguir categorías entre sí" (globals.css). La paleta
// categórica existe para el caso de varias series; aquí hay una. Además --viz-1
// es el color de San Pablo —colorRetailer resuelve por posición en RETAILERS y
// es el índice 0—, así que el total llevaría el mismo azul que una de sus partes
// dentro del mismo tooltip. La línea es el total en tinta, las partes en su
// color.

import { useMemo, useState } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { fmtMesLargo } from "@/components/lib/fmt";
import { Panel } from "@/components/ui/basicos";
import {
  CajaTooltip,
  CURSOR_LINEA,
  ejeValor,
  VIZ_ANIM,
  VIZ_GRID,
  VIZ_SUPERFICIE,
  type FilaViz,
} from "@/components/retail/viz";
import {
  formatearEjeMoneda,
  formatearMesCorto,
  formatearMoneda,
  formatearMonedaEtiqueta,
} from "@/lib/retail/analisis/formato";
import { colorRetailer } from "@/lib/retail/retailers";
import type { PuntoVentasNetas, VentasNetas } from "@/lib/retail/stats";

const ID_AREA = "cr-area-ventas-netas";

/** Alto del área de dibujo. Más que las gráficas de /retail: aquí es la pieza
 *  principal de la portada y no una de cuatro series compitiendo. */
const ALTO = 340;

/** Una casilla del eje: el mes existe siempre, el dato puede faltar. */
export interface Casilla {
  mes: number; // 1..12
  periodo: string;
  /** null = ningún retailer reportó ese mes. 0 = reportaron cero. */
  total: number | null;
  porRetailer: Record<string, number>;
}

/** Primer y último mes en que un retailer reportó pesos. */
export interface RangoRetailer {
  primero: string;
  ultimo: string;
}

/**
 * Los doce meses del año, con o sin dato.
 *
 * Se conservan las doce casillas aunque el año esté a medias: así el eje no
 * cambia de forma al cambiar de año —dos años se comparan mirando el mismo
 * ancho— y el hueco de lo que todavía no llega es en sí mismo un dato. La
 * comparativa anual de la ficha sí salta los meses vacíos, pero ahí compara DOS
 * años en el mismo eje y un mes que no existe en ninguno no es una columna.
 */
export function casillasDelAnio(serie: PuntoVentasNetas[], anio: number): Casilla[] {
  const porPeriodo = new Map(serie.map((p) => [p.periodo, p]));
  return Array.from({ length: 12 }, (_, i) => {
    const mes = i + 1;
    const periodo = `${anio}-${String(mes).padStart(2, "0")}`;
    const punto = porPeriodo.get(periodo);
    return {
      mes,
      periodo,
      // `?? null` y no `|| null`: un mes de cero ventas real es un dato, y con
      // `||` se volvería un corte de la línea.
      total: punto?.total ?? null,
      porRetailer: punto?.porRetailer ?? {},
    };
  });
}

/**
 * Rango propio de cada retailer sobre TODO el histórico. Es lo que decide si un
 * mes está incompleto.
 *
 * Sin esto, la nota de "parcial" acusa de faltar a quien nunca fue fuente: hoy
 * sólo Walmart tiene posSales —los otros tres no han cargado un peso—, así que
 * los 25 meses de la serie dirían "falta San Pablo, HEB, Farmacias del Ahorro".
 * Una advertencia que sale siempre deja de ser advertencia.
 */
export function rangosPorRetailer(serie: PuntoVentasNetas[]): Map<string, RangoRetailer> {
  const rangos = new Map<string, RangoRetailer>();
  for (const p of serie) {
    for (const id of Object.keys(p.porRetailer)) {
      const previo = rangos.get(id);
      // Los periodos son "YYYY-MM": ordenan y comparan como texto.
      rangos.set(id, {
        primero: previo && previo.primero < p.periodo ? previo.primero : p.periodo,
        ultimo: previo && previo.ultimo > p.periodo ? previo.ultimo : p.periodo,
      });
    }
  }
  return rangos;
}

/**
 * Los retailers que faltan en un mes que SÍ tuvo venta: los que ya reportaban
 * antes y volvieron a reportar después, pero no ese mes. Un hueco DENTRO del
 * rango de un retailer es un reporte que falta; fuera de su rango, simplemente
 * no era una fuente todavía.
 */
export function faltantesDelMes(
  casilla: Casilla,
  ids: string[],
  rangos: Map<string, RangoRetailer>
): string[] {
  return ids.filter((id) => {
    if (typeof casilla.porRetailer[id] === "number") return false;
    const rango = rangos.get(id);
    return (
      rango !== undefined && rango.primero <= casilla.periodo && casilla.periodo <= rango.ultimo
    );
  });
}

/**
 * Filas del tooltip: quién puso cuánto ese mes, **de mayor a menor aporte**.
 *
 * No en el orden de RETAILERS: la pregunta que se le hace a un total al pasar el
 * puntero es "¿de quién viene?", y la respuesta tiene que estar en el primer
 * renglón. El orden fijo es lo correcto cuando hay una línea por cuenta —ahí la
 * leyenda tiene que enumerar igual que la gráfica—, pero aquí la única línea es
 * la suma y no hay leyenda con la que coincidir.
 *
 * El empate se rompe por nombre para que el orden no baile entre renders.
 */
export function filasDelMes(
  casilla: Casilla,
  retailers: { id: string; nombre: string }[]
): FilaViz[] {
  return retailers
    .filter((r) => typeof casilla.porRetailer[r.id] === "number")
    .sort(
      (a, b) =>
        casilla.porRetailer[b.id] - casilla.porRetailer[a.id] ||
        a.nombre.localeCompare(b.nombre)
    )
    .map((r) => ({
      clave: r.id,
      etiqueta: r.nombre,
      color: colorRetailer(r.id),
      valor: formatearMoneda(casilla.porRetailer[r.id]),
    }));
}

/**
 * Marcador del último mes con dato, con su cifra encima.
 *
 * Se etiqueta UN punto y no los doce: una cifra junto a cada mes es ruido que
 * nadie lee, y el eje más el tooltip ya cargan el resto. El extremo es el que
 * vale porque es la lectura que se busca al abrir la portada —"¿cómo vamos?"—,
 * y de paso deja de estar escondida detrás de un hover.
 *
 * El anillo del color de la superficie separa el punto de la línea que pasa por
 * debajo; no es un borde, es aire.
 */
function PuntoFinal({
  cx,
  cy,
  indice,
  esUltimo,
  valor,
}: {
  cx?: number;
  cy?: number;
  indice: number;
  esUltimo: boolean;
  valor: number;
}) {
  if (!esUltimo || typeof cx !== "number" || typeof cy !== "number") return null;
  return (
    <g>
      <circle cx={cx} cy={cy} r={4} fill="var(--cr-ink)" stroke={VIZ_SUPERFICIE} strokeWidth={2} />
      <text
        // Diciembre no tiene aire a la derecha para centrar la cifra: ahí se
        // ancla al final en vez de salirse del área de dibujo.
        x={cx}
        y={cy - 18}
        textAnchor={indice >= 10 ? "end" : "middle"}
        // Halo del color de la superficie: la cifra puede caer encima de la
        // línea de promedio o del propio trazo, y sin el halo se lee sobre las
        // rayas. `paintOrder` pinta el contorno ANTES del relleno, así que el
        // grosor no engorda la letra.
        stroke={VIZ_SUPERFICIE}
        strokeWidth={3}
        paintOrder="stroke"
        style={{
          fill: "var(--cr-ink)",
          fontSize: 12,
          fontFamily: "var(--cr-font-mono)",
          fontWeight: 600,
        }}
      >
        {formatearMonedaEtiqueta(valor)}
      </text>
    </g>
  );
}

/**
 * Rótulo de la línea de promedio.
 *
 * Va con el mismo halo que la cifra del extremo y no con el `label` normal de
 * ReferenceLine: la referencia es horizontal y la línea de venta la cruza, así
 * que el texto acaba con el trazo y las rayas encima. Sin halo, "Prom. $6.41 M"
 * se lee tachado.
 */
function EtiquetaPromedio({ viewBox, valor }: { viewBox?: { x?: number; y?: number }; valor: number }) {
  const x = viewBox?.x;
  const y = viewBox?.y;
  if (typeof x !== "number" || typeof y !== "number") return null;
  return (
    <text
      // Encima de la línea, no debajo: abajo cae dentro del lavado del área,
      // donde el gris del relleno le come el contraste.
      x={x + 6}
      y={y - 6}
      stroke={VIZ_SUPERFICIE}
      strokeWidth={3}
      paintOrder="stroke"
      style={{
        fill: "var(--cr-ink-3)",
        fontSize: 10.5,
        fontFamily: "var(--cr-font-mono)",
      }}
    >
      {`Prom. ${formatearMonedaEtiqueta(valor)}`}
    </text>
  );
}

export function VentasNetasChart({ datos }: { datos: VentasNetas }) {
  const [anio, setAnio] = useState(datos.anioActual);

  const casillas = useMemo(() => casillasDelAnio(datos.serie, anio), [datos.serie, anio]);
  const rangos = useMemo(() => rangosPorRetailer(datos.serie), [datos.serie]);

  const conDato = casillas.filter((c) => typeof c.total === "number");
  const ultimo = conDato.at(-1);

  // El índice sobre las DOCE casillas y no sobre las que tienen dato: es el que
  // recharts le pasa al renderer del punto.
  const iUltimo = ultimo ? casillas.findIndex((c) => c.periodo === ultimo.periodo) : -1;

  // Promedio sobre los meses CON venta y no sobre doce: un mes que todavía no
  // llega no es un mes de cero y hundiría la referencia. Es el mismo criterio
  // del `promedioMensual` de resumenDashboard.
  //
  // Con un solo mes no hay promedio que dibujar: la línea caería justo encima
  // del único punto y no diría nada.
  const promedio =
    conDato.length > 1
      ? conDato.reduce((t, c) => t + (c.total ?? 0), 0) / conDato.length
      : null;

  const selector = (
    <label className="cr-field">
      <select
        className="cr-input w-auto"
        // El label visible se quitó para dejar la cabecera limpia, así que el
        // nombre accesible tiene que venir de aquí: un <select> a secas se
        // anuncia sin decir de qué es.
        aria-label="Año"
        value={String(anio)}
        onChange={(e) => setAnio(Number(e.target.value))}
      >
        {datos.anios.map((a) => (
          <option key={a} value={a}>
            {a}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <Panel title="Ventas netas del año" acciones={selector}>

      {conDato.length === 0 ? (
        // Doce nulos pintarían una reja con ejes y sin línea, que se lee como
        // software roto. El selector se queda montado para que esto sea
        // legible como resultado del filtro, y la altura no cambia para que
        // cambiar de año no salte la página.
        <div className="flex items-center justify-center" style={{ minHeight: ALTO }}>
          <p className="cr-body text-center">
            {datos.serie.length === 0
              ? "Todavía no hay ventas registradas. Sube el reporte de un retailer para ver la evolución."
              : `Sin reportes de ${anio}. Elige otro año para ver la evolución.`}
          </p>
        </div>
      ) : (
        <div style={{ height: ALTO }}>
          <ResponsiveContainer debounce={50}>
            {/* Aire arriba para la cifra del extremo y a la derecha para que no
                se recorte cuando el último mes cae al filo del área. */}
            <ComposedChart data={casillas} margin={{ top: 28, right: 28, bottom: 4, left: 4 }}>
              <defs>
                {/* Degradado propio y no el DegradadoArea compartido: ese es una
                    rampa recta calibrada para CUATRO lavados superpuestos.
                    Aquí el área es enorme —el eje arranca en cero y la venta
                    vive arriba de los cinco millones—, así que una rampa recta
                    la vuelve una losa gris que le gana al trazo. La caída rápida
                    concentra el tono bajo la línea, que es donde dice algo, y
                    deja el resto casi limpio. El lavado nunca es un bloque: lo
                    que se sigue con la vista es la línea. */}
                <linearGradient id={ID_AREA} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--cr-ink)" stopOpacity={0.14} />
                  <stop offset="35%" stopColor="var(--cr-ink)" stopOpacity={0.04} />
                  <stop offset="100%" stopColor="var(--cr-ink)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke={VIZ_GRID} vertical={false} />
              {/* El mes (1..12) y no el periodo: el año ya lo nombra la
                  cabecera, y "ene 26" repetido doce veces es ruido. */}
              <XAxis
                dataKey="mes"
                tickFormatter={formatearMesCorto}
                tickMargin={10}
                {...ejeValor}
              />
              <YAxis tickFormatter={formatearEjeMoneda} width={56} tickMargin={6} {...ejeValor} />
              <Tooltip
                cursor={CURSOR_LINEA}
                // Las filas se arman desde el punto de datos y no desde el
                // payload de recharts: así el orden lo manda este archivo.
                content={({ active, payload }) => {
                  if (!active) return null;
                  const punto = payload?.[0]?.payload as Casilla | undefined;
                  if (!punto || typeof punto.total !== "number") return null;

                  const filas = filasDelMes(punto, datos.retailers);

                  // Una línea sumada no distingue "se vendió menos en marzo" de
                  // "HEB no ha subido marzo": las dos se ven como un bajón, y el
                  // corte ocurre DENTRO de la suma, donde connectNulls no llega.
                  // Los retailers no reportan al mismo ritmo, así que el
                  // desglose no es adorno: es lo que revela un total parcial.
                  const faltan = faltantesDelMes(
                    punto,
                    datos.retailers.map((r) => r.id),
                    rangos
                  ).map((id) => datos.retailers.find((r) => r.id === id)?.nombre ?? id);

                  return (
                    <CajaTooltip
                      titulo={fmtMesLargo(punto.periodo)}
                      filas={filas}
                      total={{
                        clave: "total",
                        etiqueta: "Total",
                        nota:
                          faltan.length > 0 ? `parcial · falta ${faltan.join(", ")}` : undefined,
                        valor: formatearMoneda(punto.total),
                      }}
                    />
                  );
                }}
              />
              <Area
                type="monotone"
                dataKey="total"
                stroke="none"
                fill={`url(#${ID_AREA})`}
                connectNulls={false}
                isAnimationActive={false}
                activeDot={false}
              />
              {/* El promedio del año da con qué comparar cada mes sin agregar
                  una segunda serie: se ve de un golpe qué meses van arriba y
                  cuáles abajo. Va punteada porque es un umbral y no un dato
                  medido —la rejilla, en cambio, es sólida a propósito. */}
              {promedio !== null ? (
                <ReferenceLine
                  y={promedio}
                  stroke="var(--cr-ink-3)"
                  strokeDasharray="4 4"
                  strokeWidth={1}
                  label={<EtiquetaPromedio valor={promedio} />}
                />
              ) : null}
              {/* `connectNulls` apagado a propósito: un mes sin reporte se
                  corta, no se interpola ni cae al suelo. */}
              <Line
                type="monotone"
                dataKey="total"
                name="Ventas netas"
                stroke="var(--cr-ink)"
                strokeWidth={2.25}
                strokeLinecap="round"
                strokeLinejoin="round"
                dot={(props) => {
                  const { cx, cy, index, key } = props as {
                    cx?: number;
                    cy?: number;
                    index: number;
                    key?: string;
                  };
                  return (
                    <PuntoFinal
                      key={key ?? `punto-${index}`}
                      cx={cx}
                      cy={cy}
                      indice={index}
                      esUltimo={index === iUltimo}
                      valor={casillas[index]?.total ?? 0}
                    />
                  );
                }}
                activeDot={{ r: 4, strokeWidth: 2, stroke: VIZ_SUPERFICIE }}
                connectNulls={false}
                animationDuration={VIZ_ANIM}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
    </Panel>
  );
}
