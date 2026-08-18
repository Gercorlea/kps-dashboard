"use client";

// El ÚNICO archivo del analizador que importa recharts. Se carga como chunk
// aparte con next/dynamic desde AnalisisExcel, así que nada de esto entra al
// bundle hasta que el usuario carga un archivo.
//
// No hace ningún cálculo: recibe arreglos ya agregados (<=200 puntos) por props.

import { memo } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  LabelList,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Panel } from "@/components/ui/basicos";
import { OTROS, type ComparativaAnual } from "@/lib/retail/analisis/agregar";
import {
  formatearCompacto,
  formatearEntero,
  formatearMesCorto,
  formatearMoneda,
  formatearMonedaCompacta,
  formatearNumero,
  formatearPorcentaje,
} from "@/lib/retail/analisis/formato";
import type {
  Agregacion,
  Granularidad,
  PuntoAgrupado,
  PuntoSerie,
} from "@/lib/retail/analisis/tipos";

// HistoricoCharts resuelve sus series con tinta/ok/danger porque cada gráfica
// lleva una sola serie con significado propio. Aquí hace falta distinguir
// CATEGORÍAS entre sí (la barra de participación), y para eso el design system
// no tiene paleta: se usan los tokens --viz-* de globals.css, validados para
// daltonismo. Se usan también en la gráfica de una sola serie para que las dos
// tarjetas no hablen idiomas distintos.
const SLOTS = [
  "var(--viz-1)",
  "var(--viz-2)",
  "var(--viz-3)",
  "var(--viz-4)",
  "var(--viz-5)",
  "var(--viz-6)",
];
const SLOT_OTROS = SLOTS[5];

const GRID = "var(--cr-line-soft)";
const LABEL = "var(--cr-ink-3)";
const SUPERFICIE = "var(--cr-surface)";

// Mismos ejes que HistoricoCharts: mono, 10px, tinta 3.
const ejes = {
  tick: { fontSize: 10, fill: LABEL, fontFamily: "var(--cr-font-mono)" },
  stroke: GRID,
};

const ESTILO_TOOLTIP = { fontSize: 12, borderRadius: 2 };

interface LeyendaItem {
  clave: string;
  etiqueta: string;
  color: string;
  /** Cifra al lado del nombre; en la de participación, el porcentaje. */
  nota?: string;
}

interface Props {
  datosBarra: PuntoAgrupado[];
  datosSerie: PuntoSerie[] | null;
  datosComposicion: PuntoAgrupado[];
  /**
   * Comparativa año contra año. Opcional: sólo la ficha del retailer la manda,
   * y sin dos años de reportes no hay nada que comparar (null).
   */
  datosAnual?: ComparativaAnual | null;
  nombreDimension: string | null;
  nombreMetrica: string;
  agregacion: Agregacion;
  granularidad: Granularidad;
  /**
   * La métrica elegida es un importe: ejes, etiquetas y tooltips llevan "$".
   * Lo decide el llamador a partir de la plantilla —no se adivina del número—
   * y por omisión es false, que es como se comportaban las gráficas antes.
   */
  metricaMoneda?: boolean;
}

const ETIQUETA_PERIODO: Record<Granularidad, string> = {
  dia: "día",
  mes: "mes",
  anio: "año",
};

const ETIQUETA_AGREGACION: Record<Agregacion, string> = {
  suma: "Total",
  promedio: "Promedio",
  conteo: "Cantidad",
};

/** Variación con signo explícito: un "+5%" se distingue de un "5%" a secas. */
function formatearPorcentajeConSigno(fraccion: number): string {
  const texto = formatearPorcentaje(fraccion);
  return fraccion > 0 ? `+${texto}` : texto;
}

function acortar(texto: string, max = 18): string {
  return texto.length > max ? `${texto.slice(0, max - 1)}…` : texto;
}

// Recharts tipa los valores que pasa a los formatters como ValueType | undefined
// (puede ser string, número o arreglo). Se estrechan aquí en vez de repetir
// castings en cada callback.
function comoNumero(v: unknown): number {
  return typeof v === "number" ? v : Number(v);
}

function comoTexto(v: unknown): string {
  return v === null || v === undefined ? "" : String(v);
}

/**
 * Leyenda en HTML plano en vez del <Legend> de recharts: la versión 3 quitó la
 * prop `payload`, con lo que no hay forma de fijar el orden y la librería las
 * ordena alfabéticamente, desalineando la leyenda de los segmentos.
 *
 * El texto va en tinta, nunca en el color de la serie: el cuadrito ya lleva la
 * identidad.
 */
function Leyenda({ puntos }: { puntos: LeyendaItem[] }) {
  return (
    <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
      {puntos.map((p) => (
        <li key={p.clave} className="flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="size-2.5 shrink-0"
            style={{ background: p.color, borderRadius: "var(--cr-r-xs)" }}
          />
          <span className="cr-small" style={{ color: "var(--cr-ink-2)" }}>
            {p.etiqueta}
          </span>
          {p.nota ? <span className="cr-mono cr-small">{p.nota}</span> : null}
        </li>
      ))}
    </ul>
  );
}

function AnalisisChartsBase({
  datosBarra,
  datosSerie,
  datosComposicion,
  datosAnual = null,
  nombreDimension,
  nombreMetrica,
  agregacion,
  granularidad,
  metricaMoneda = false,
}: Props) {
  const hayDimension = nombreDimension !== null && datosBarra.length > 0;

  // Los dos formateadores de la métrica en un solo lugar: los usan el eje, la
  // etiqueta de barra y los tres tooltips, y así no queda una gráfica con "$"
  // y otra sin él.
  const fmtValor = metricaMoneda ? formatearMoneda : formatearNumero;
  const fmtValorCompacto = metricaMoneda ? formatearMonedaCompacta : formatearCompacto;

  // Participación sólo tiene sentido con magnitudes aditivas y positivas: con
  // valores negativos un 100% apilado miente. En ese caso no se dibuja.
  const totalComposicion = datosComposicion.reduce((s, p) => s + p.valor, 0);
  const composicionValida =
    datosComposicion.length > 1 &&
    totalComposicion > 0 &&
    datosComposicion.every((p) => p.valor >= 0);

  const filaComposicion: Record<string, number | string> = { etiqueta: "total" };
  if (composicionValida) {
    for (const p of datosComposicion) filaComposicion[p.clave] = p.valor;
  }

  const colorSegmento = (clave: string, i: number) =>
    clave === OTROS ? SLOT_OTROS : SLOTS[i];

  const leyendaComposicion: LeyendaItem[] = datosComposicion.map((p, i) => ({
    clave: p.clave,
    etiqueta:
      p.gruposPlegados !== undefined
        ? `${p.clave} (${formatearEntero(p.gruposPlegados)} grupos)`
        : acortar(p.clave, 28),
    color: colorSegmento(p.clave, i),
    nota: totalComposicion > 0 ? formatearPorcentaje(p.valor / totalComposicion) : "",
  }));

  // "Otros" no es un puesto del top: es lo que quedó fuera.
  const nTop = datosBarra.filter((p) => p.clave !== OTROS).length;
  const nTopComposicion = datosComposicion.filter((p) => p.clave !== OTROS).length;

  if (!hayDimension) {
    return (
      <Panel>
        <p className="cr-body py-6 text-center">
          No se detectaron columnas para agrupar, así que no hay gráficas por categoría.
        </p>
      </Panel>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Panel title={`Top ${nTop} por ${nombreDimension}`}>
        <p className="cr-small mb-2">
          {ETIQUETA_AGREGACION[agregacion]} de {nombreMetrica}
        </p>
        {/* Alto según el número de barras: con 4 categorías un alto fijo de
            240px dejaba media tarjeta vacía. */}
        <div style={{ height: Math.max(150, datosBarra.length * 26 + 46) }}>
          <ResponsiveContainer debounce={50}>
            <BarChart
              data={datosBarra}
              layout="vertical"
              margin={{ top: 4, right: 52, bottom: 8, left: 4 }}
            >
              <CartesianGrid stroke={GRID} horizontal={false} />
              <XAxis type="number" tickFormatter={fmtValorCompacto} {...ejes} />
              <YAxis
                type="category"
                dataKey="clave"
                width={130}
                tickFormatter={(v: string) => acortar(v)}
                {...ejes}
              />
              <Tooltip
                cursor={{ fill: "var(--cr-surface-3)" }}
                contentStyle={ESTILO_TOOLTIP}
                formatter={(v: unknown) =>
                  [fmtValor(comoNumero(v)), nombreMetrica] as [string, string]
                }
              />
              {/* Una sola serie ⇒ un solo color. Un degradado por valor
                  duplicaría el largo de la barra en el tono y gastaría el
                  único canal libre. Sin leyenda: el título nombra la serie. */}
              <Bar
                dataKey="valor"
                fill={SLOTS[0]}
                maxBarSize={22}
                radius={[0, 2, 2, 0]}
                isAnimationActive={false}
              >
                <LabelList
                  dataKey="valor"
                  position="right"
                  formatter={(v: unknown) => fmtValorCompacto(comoNumero(v))}
                  style={{ fill: LABEL, fontSize: 10, fontFamily: "var(--cr-font-mono)" }}
                />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Panel>

      {datosSerie && datosSerie.length > 1 ? (
        <Panel title={`${nombreMetrica} por ${ETIQUETA_PERIODO[granularidad]}`}>
          <p className="cr-small mb-2">
            {ETIQUETA_AGREGACION[agregacion]}; los periodos sin datos se muestran en cero
          </p>
          <div style={{ height: 200 }}>
            <ResponsiveContainer debounce={50}>
              <LineChart data={datosSerie} margin={{ top: 8, right: 24, bottom: 8, left: 8 }}>
                <CartesianGrid stroke={GRID} vertical={false} />
                <XAxis dataKey="clave" minTickGap={24} {...ejes} />
                <YAxis width={48} tickFormatter={fmtValorCompacto} {...ejes} />
                <Tooltip
                  contentStyle={ESTILO_TOOLTIP}
                  labelFormatter={(v: unknown) => comoTexto(v)}
                  formatter={(v: unknown) =>
                    [fmtValor(comoNumero(v)), nombreMetrica] as [string, string]
                  }
                />
                <Line
                  type="monotone"
                  dataKey="valor"
                  stroke={SLOTS[0]}
                  strokeWidth={1.75}
                  dot={false}
                  activeDot={{ r: 4, strokeWidth: 2, stroke: SUPERFICIE }}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Panel>
      ) : null}

      {datosAnual ? (
        <Panel
          title={`${nombreMetrica}: ${datosAnual.anioActual} vs ${datosAnual.anioPrevio}`}
        >
          <p className="cr-small mb-2">
            {datosAnual.mesesComparables > 0
              ? ` ${fmtValor(datosAnual.totalActual)} vs ${fmtValor(
                  datosAnual.totalPrevio
                )} sobre los ${datosAnual.mesesComparables} ${
                  datosAnual.mesesComparables === 1 ? "mes" : "meses"
                } que tienen los dos años${
                  datosAnual.variacion === null
                    ? ""
                    : ` (${formatearPorcentajeConSigno(datosAnual.variacion)})`
                }`
              : " · los dos años no comparten ningún mes, así que no hay total que comparar"}
          </p>
          <div style={{ height: 240 }}>
            <ResponsiveContainer debounce={50}>
              <BarChart
                data={datosAnual.puntos}
                margin={{ top: 8, right: 16, bottom: 8, left: 8 }}
              >
                <CartesianGrid stroke={GRID} vertical={false} />
                <XAxis dataKey="mes" tickFormatter={formatearMesCorto} {...ejes} />
                <YAxis width={48} tickFormatter={fmtValorCompacto} {...ejes} />
                <Tooltip
                  cursor={{ fill: "var(--cr-surface-3)" }}
                  contentStyle={ESTILO_TOOLTIP}
                  labelFormatter={(v: unknown) => formatearMesCorto(comoNumero(v))}
                  formatter={(v: unknown, nombre: unknown) =>
                    [fmtValor(comoNumero(v)), comoTexto(nombre)] as [string, string]
                  }
                />
                {/* El año previo va primero para que quede a la IZQUIERDA de
                    cada par: se lee de atrás hacia adelante, como el tiempo.
                    Un mes en null no dibuja barra —recharts lo salta— y así un
                    mes que todavía no llega no parece una venta en cero. */}
                <Bar
                  dataKey="previo"
                  name={String(datosAnual.anioPrevio)}
                  fill={SLOTS[1]}
                  maxBarSize={26}
                  radius={[2, 2, 0, 0]}
                  isAnimationActive={false}
                />
                <Bar
                  dataKey="actual"
                  name={String(datosAnual.anioActual)}
                  fill={SLOTS[0]}
                  maxBarSize={26}
                  radius={[2, 2, 0, 0]}
                  isAnimationActive={false}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <Leyenda
            puntos={[
              {
                clave: "previo",
                etiqueta: String(datosAnual.anioPrevio),
                color: SLOTS[1],
              },
              {
                clave: "actual",
                etiqueta: String(datosAnual.anioActual),
                color: SLOTS[0],
              },
            ]}
          />
        </Panel>
      ) : null}

      {composicionValida ? (
        <Panel title={`Participación por ${nombreDimension}`}>
          <p className="cr-small mb-2">
            Top {nTopComposicion} sobre el total
            {agregacion === "promedio" ? " (siempre suma: un promedio no es aditivo)" : ""}
          </p>
          <div style={{ height: 44 }}>
            <ResponsiveContainer debounce={50}>
              <BarChart
                data={[filaComposicion]}
                layout="vertical"
                margin={{ top: 0, right: 0, bottom: 0, left: 0 }}
              >
                <XAxis type="number" hide domain={[0, totalComposicion]} />
                <YAxis type="category" dataKey="etiqueta" hide />
                <Tooltip
                  cursor={false}
                  contentStyle={ESTILO_TOOLTIP}
                  formatter={(v: unknown, nombre: unknown) => {
                    const n = comoNumero(v);
                    return [
                      `${fmtValor(n)} · ${formatearPorcentaje(n / totalComposicion)}`,
                      acortar(comoTexto(nombre), 28),
                    ] as [string, string];
                  }}
                />
                {/* El trazo va del color de la superficie: se lee como espacio
                    negativo entre segmentos, no como tinta de dato. */}
                {datosComposicion.map((p, i) => (
                  <Bar
                    key={p.clave}
                    dataKey={p.clave}
                    stackId="s"
                    fill={colorSegmento(p.clave, i)}
                    stroke={SUPERFICIE}
                    strokeWidth={2}
                    isAnimationActive={false}
                    radius={
                      i === 0
                        ? [2, 0, 0, 2]
                        : i === datosComposicion.length - 1
                          ? [0, 2, 2, 0]
                          : undefined
                    }
                  />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
          <Leyenda puntos={leyendaComposicion} />
        </Panel>
      ) : null}
    </div>
  );
}

export default memo(AnalisisChartsBase);
