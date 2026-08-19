"use client";

// El ÚNICO archivo del analizador que importa recharts. Se carga como chunk
// aparte con next/dynamic desde AnalisisExcel y desde la ficha del retailer,
// así que nada de esto entra al bundle hasta que hay datos que dibujar.
//
// No hace ningún cálculo sobre los datos: recibe arreglos ya agregados
// (<=200 puntos) por props. Lo único que deriva son cifras de cabecera —el
// último periodo y su variación—, que salen de la serie que ya tiene en mano.
//
// El cromo (ejes, tooltip, leyenda, degradados) vive en ./viz, compartido con
// la gráfica de /retail para que las dos rutas se vean iguales.

import { memo, useState } from "react";
import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  LabelList,
  Line,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Panel } from "@/components/ui/basicos";
import {
  acortar,
  CajaTooltip,
  comoNumero,
  comoTexto,
  CURSOR_BANDA,
  CURSOR_LINEA,
  DegradadoArea,
  DegradadoBarra,
  Delta,
  ejeCategoria,
  ejeValor,
  Leyenda,
  VIZ_ANIM,
  VIZ_GRID,
  VIZ_SUPERFICIE,
  type FilaViz,
} from "@/components/retail/viz";
import { OTROS, type ComparativaAnual } from "@/lib/retail/analisis/agregar";
import {
  formatearCompacto,
  formatearEje,
  formatearEjeMoneda,
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

/**
 * Color de un segmento de la participación. Por POSICIÓN en el top, salvo
 * "Otros", que tiene slot propio: no es un puesto del ranking sino lo que quedó
 * fuera, y así conserva su color aunque cambie cuántos grupos se plegaron.
 */
function colorSegmento(clave: string, i: number): string {
  return clave === OTROS ? SLOT_OTROS : SLOTS[i];
}

// Ids de los degradados. Fijos y con prefijo: conviven en el mismo documento
// con los de la gráfica de /retail.
const GRAD_SERIE = "cr-grad-serie";
const GRAD_BARRA = "cr-grad-barra";
const GRAD_ACTUAL = "cr-grad-anual-actual";
const GRAD_PREVIO = "cr-grad-anual-previo";

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

/**
 * Variación del último punto de la serie contra el anterior. Null cuando no hay
 * con qué comparar o cuando el punto previo es cero: dividir entre cero daría un
 * "∞%" que no dice nada (§8.1).
 */
function variacionUltimo(serie: PuntoSerie[]): number | null {
  if (serie.length < 2) return null;
  const previo = serie[serie.length - 2].valor;
  if (previo === 0) return null;
  return (serie[serie.length - 1].valor - previo) / Math.abs(previo);
}

/** Lado del cuadro del anillo. Fijo: recharts necesita medidas para resolver
 *  los radios, y un anillo cuadrado no gana nada con estirarse. */
const DONA_LADO = 208;

/**
 * Participación sobre el total, como anillo con leyenda al costado.
 *
 * Era una barra 100% apilada de 52px. La dona dice lo mismo —el reparto de un
 * total entre pocas categorías— y de un golpe, que es justo el caso donde una
 * dona funciona: nunca hay más de seis gajos (los llamadores piden top 5 y
 * `plegarTopN` mete el resto en "Otros"), el centro no se desperdicia porque
 * ancla el total, y las cifras exactas siguen a la vista en la leyenda. Comparar
 * valores parecidos con precisión es trabajo de la tarjeta de al lado, el
 * ranking del top N.
 *
 * El estado del foco vive aquí y no en el componente de arriba para que asomar
 * un gajo no vuelva a dibujar las otras tres gráficas.
 */
function ParticipacionDona({
  puntos,
  total,
  fmtValor,
  fmtValorCompacto,
}: {
  puntos: PuntoAgrupado[];
  total: number;
  fmtValor: (n: number) => string;
  fmtValorCompacto: (n: number) => string;
}) {
  // Igual que en la gráfica de /retail: el clic FIJA el gajo y el puntero sólo
  // lo asoma, así que pasar por otro y salir devuelve al fijado.
  const [fijo, setFijo] = useState<string | null>(null);
  const [asomado, setAsomado] = useState<string | null>(null);
  const foco = asomado ?? fijo;

  const enfocado = foco === null ? null : puntos.find((p) => p.clave === foco) ?? null;

  const leyenda: FilaViz[] = puntos.map((p, i) => ({
    clave: p.clave,
    etiqueta:
      p.gruposPlegados !== undefined
        ? `${p.clave} (${formatearEntero(p.gruposPlegados)} grupos)`
        : p.clave,
    color: colorSegmento(p.clave, i),
    valor: formatearPorcentaje(p.valor / total),
    nota: fmtValorCompacto(p.valor),
  }));

  return (
    <div className="cr-viz-dona">
      <div className="cr-viz-dona__anillo" style={{ width: DONA_LADO, height: DONA_LADO }}>
        {/* Sin <Tooltip>: la caja aparecía bajo el puntero, es decir ENCIMA del
            anillo y del agujero, tapando justo la cifra del gajo que se está
            señalando. El centro y la leyenda ya dicen nombre, porcentaje e
            importe del gajo con foco, y con más tamaño que un tooltip. */}
        <PieChart width={DONA_LADO} height={DONA_LADO}>
          {/* Arranca a las 12 y gira con el reloj (endAngle negativo), que es
              como se lee un reparto. El trazo va del color de la superficie: el
              hueco entre gajos es aire, no un borde de dato. */}
          <Pie
            data={puntos}
            dataKey="valor"
            nameKey="clave"
            startAngle={90}
            endAngle={-270}
            innerRadius={58}
            outerRadius={84}
            paddingAngle={1.2}
            cornerRadius={2}
            stroke={VIZ_SUPERFICIE}
            strokeWidth={2}
            animationDuration={VIZ_ANIM}
            // El mismo estado que la leyenda: asomar un gajo ilumina su fila y
            // asomar una fila resalta su gajo.
            onMouseEnter={(_, i) => setAsomado(puntos[i]?.clave ?? null)}
            onMouseLeave={() => setAsomado(null)}
            onClick={(_, i) => {
              const clave = puntos[i]?.clave ?? null;
              setFijo((actual) => (actual === clave ? null : clave));
            }}
          >
            {puntos.map((p, i) => (
              <Cell
                key={p.clave}
                fill={colorSegmento(p.clave, i)}
                fillOpacity={foco === null || foco === p.clave ? 1 : 0.22}
                style={{ cursor: "pointer" }}
              />
            ))}
          </Pie>
        </PieChart>
        {/* El agujero lleva el total, y el gajo con foco lo cambia por su
            porcentaje y su importe exacto: la cifra que se está mirando queda en
            el centro de la gráfica y no en una caja flotante. */}
        <div className="cr-viz-dona__centro">
          <span className="cr-viz-dona__etiqueta">
            {enfocado ? acortar(enfocado.clave, 14) : "Total"}
          </span>
          <span className="cr-viz-dona__cifra">
            {enfocado
              ? formatearPorcentaje(enfocado.valor / total)
              : fmtValorCompacto(total)}
          </span>
          {enfocado ? (
            <span className="cr-viz-dona__exacto">{fmtValor(enfocado.valor)}</span>
          ) : null}
        </div>
      </div>
      <div className="cr-viz-dona__leyenda">
        <Leyenda
          items={leyenda}
          foco={foco}
          lista
          onFijar={setFijo}
          onAsomar={setAsomado}
        />
      </div>
    </div>
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
  // Las marcas de eje abrevian antes que las etiquetas de barra: ver
  // `formatearEje`.
  const fmtEje = metricaMoneda ? formatearEjeMoneda : formatearEje;

  // Participación sólo tiene sentido con magnitudes aditivas y positivas: con
  // valores negativos un reparto sobre el total miente. En ese caso no se dibuja.
  const totalComposicion = datosComposicion.reduce((s, p) => s + p.valor, 0);
  const composicionValida =
    datosComposicion.length > 1 &&
    totalComposicion > 0 &&
    datosComposicion.every((p) => p.valor >= 0);

  // "Otros" no es un puesto del top: es lo que quedó fuera.
  const nTop = datosBarra.filter((p) => p.clave !== OTROS).length;
  const nTopComposicion = datosComposicion.filter((p) => p.clave !== OTROS).length;

  const haySerie = Boolean(datosSerie && datosSerie.length > 1);
  const ultimoPunto = haySerie ? datosSerie![datosSerie!.length - 1] : null;
  const varSerie = haySerie ? variacionUltimo(datosSerie!) : null;

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
      {/* El orden es el de la lectura de la ficha: primero cómo va el año
          contra el anterior, luego la evolución mes a mes, después qué
          categorías la explican y al final cómo se reparten el total. Cada
          gráfica ocupa el ancho completo: son cuatro lecturas distintas y
          ninguna se compara con la de al lado. */}
      {datosAnual ? (
        <Panel
          title={`${nombreMetrica}: ${datosAnual.anioActual} vs ${datosAnual.anioPrevio}`}
          acciones={
            datosAnual.variacion === null ? null : (
              <Delta
                fraccion={datosAnual.variacion}
                texto={formatearPorcentajeConSigno(datosAnual.variacion)}
              />
            )
          }
        >
          <p className="cr-viz-sub">
            {datosAnual.mesesComparables > 0
              ? `${fmtValor(datosAnual.totalActual)} vs ${fmtValor(
                  datosAnual.totalPrevio
                )} sobre los ${datosAnual.mesesComparables} ${
                  datosAnual.mesesComparables === 1 ? "mes" : "meses"
                } que tienen los dos años`
              : "Los dos años no comparten ningún mes, así que no hay total que comparar"}
          </p>
          <div style={{ height: 248 }}>
            <ResponsiveContainer debounce={50}>
              <BarChart
                data={datosAnual.puntos}
                margin={{ top: 8, right: 16, bottom: 8, left: 8 }}
                barGap={2}
                barCategoryGap="22%"
              >
                <defs>
                  <DegradadoBarra id={GRAD_ACTUAL} color={SLOTS[0]} />
                  <DegradadoBarra id={GRAD_PREVIO} color={SLOTS[1]} />
                </defs>
                <CartesianGrid stroke={VIZ_GRID} vertical={false} />
                <XAxis dataKey="mes" tickFormatter={formatearMesCorto} {...ejeValor} />
                <YAxis width={48} tickFormatter={fmtEje} {...ejeValor} />
                <Tooltip
                  cursor={CURSOR_BANDA}
                  content={({ active, payload }) => {
                    const punto = payload?.[0]?.payload as
                      | ComparativaAnual["puntos"][number]
                      | undefined;
                    if (!active || !punto) return null;
                    // Un mes que todavía no llega no tiene barra ni fila: el
                    // tooltip no inventa un cero.
                    const filas: FilaViz[] = [];
                    if (typeof punto.previo === "number") {
                      filas.push({
                        clave: "previo",
                        etiqueta: String(datosAnual.anioPrevio),
                        color: SLOTS[1],
                        valor: fmtValor(punto.previo),
                      });
                    }
                    if (typeof punto.actual === "number") {
                      filas.push({
                        clave: "actual",
                        etiqueta: String(datosAnual.anioActual),
                        color: SLOTS[0],
                        valor: fmtValor(punto.actual),
                      });
                    }
                    return (
                      <CajaTooltip
                        titulo={formatearMesCorto(punto.mes)}
                        filas={filas}
                      />
                    );
                  }}
                />
                {/* El año previo va primero para que quede a la IZQUIERDA de
                    cada par: se lee de atrás hacia adelante, como el tiempo.
                    Un mes en null no dibuja barra —recharts lo salta— y así un
                    mes que todavía no llega no parece una venta en cero. */}
                <Bar
                  dataKey="previo"
                  name={String(datosAnual.anioPrevio)}
                  fill={`url(#${GRAD_PREVIO})`}
                  maxBarSize={20}
                  radius={[3, 3, 0, 0]}
                  animationDuration={VIZ_ANIM}
                />
                <Bar
                  dataKey="actual"
                  name={String(datosAnual.anioActual)}
                  fill={`url(#${GRAD_ACTUAL})`}
                  maxBarSize={20}
                  radius={[3, 3, 0, 0]}
                  animationDuration={VIZ_ANIM}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <Leyenda
            items={[
              {
                clave: "previo",
                etiqueta: String(datosAnual.anioPrevio),
                color: SLOTS[1],
                valor: fmtValorCompacto(datosAnual.totalPrevio),
              },
              {
                clave: "actual",
                etiqueta: String(datosAnual.anioActual),
                color: SLOTS[0],
                valor: fmtValorCompacto(datosAnual.totalActual),
              },
            ]}
          />
        </Panel>
      ) : null}

      {haySerie && ultimoPunto ? (
        <Panel
          title={`${nombreMetrica} por ${ETIQUETA_PERIODO[granularidad]}`}
          acciones={
            <div className="cr-viz-head">
              <span className="cr-viz-head__valor">{fmtValor(ultimoPunto.valor)}</span>
              <Delta
                fraccion={varSerie}
                texto={varSerie === null ? "—" : formatearPorcentajeConSigno(varSerie)}
              />
            </div>
          }
        >
          <div style={{ height: 240 }}>
            <ResponsiveContainer debounce={50}>
              <ComposedChart
                data={datosSerie!}
                margin={{ top: 8, right: 24, bottom: 8, left: 8 }}
              >
                <defs>
                  <DegradadoArea id={GRAD_SERIE} color={SLOTS[0]} />
                </defs>
                <CartesianGrid stroke={VIZ_GRID} vertical={false} />
                <XAxis dataKey="clave" minTickGap={24} {...ejeValor} />
                <YAxis width={48} tickFormatter={fmtEje} {...ejeValor} />
                <Tooltip
                  cursor={CURSOR_LINEA}
                  content={({ active, label, payload }) => {
                    const punto = payload?.[0]?.payload as PuntoSerie | undefined;
                    if (!active || !punto) return null;
                    return (
                      <CajaTooltip
                        titulo={comoTexto(label)}
                        filas={[
                          {
                            clave: "valor",
                            etiqueta: nombreMetrica,
                            color: SLOTS[0],
                            valor: fmtValor(punto.valor),
                          },
                        ]}
                      />
                    );
                  }}
                />
                {/* El área es un lavado bajo la línea: da volumen sin competir
                    con el trazo, que es lo que se sigue con la vista. */}
                <Area
                  type="monotone"
                  dataKey="valor"
                  stroke="none"
                  fill={`url(#${GRAD_SERIE})`}
                  isAnimationActive={false}
                  activeDot={false}
                />
                <Line
                  type="monotone"
                  dataKey="valor"
                  stroke={SLOTS[0]}
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  dot={false}
                  activeDot={{ r: 4, strokeWidth: 2, stroke: VIZ_SUPERFICIE }}
                  animationDuration={VIZ_ANIM}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </Panel>
      ) : null}

      {/* Las dos lecturas de la dimensión van pareadas: el ranking dice
          cuánto vende cada una y la barra apilada cómo se reparten el total.
          Se leen juntas, así que comparten fila; arriba quedan las dos
          lecturas de tiempo, que sí necesitan el ancho completo. */}
      <div
        className={`grid grid-cols-1 items-start gap-4${
          composicionValida ? " xl:grid-cols-2" : ""
        }`}
      >
        <Panel title={`Top ${nTop} por ${nombreDimension}`}>
          <p className="cr-viz-sub">
            {ETIQUETA_AGREGACION[agregacion]} de {nombreMetrica}
          </p>
          {/* Alto según el número de barras: con 4 categorías un alto fijo de
              240px dejaba media tarjeta vacía. */}
          <div style={{ height: Math.max(160, datosBarra.length * 30 + 44) }}>
            <ResponsiveContainer debounce={50}>
              <BarChart
                data={datosBarra}
                layout="vertical"
                margin={{ top: 4, right: 56, bottom: 8, left: 4 }}
                barCategoryGap="26%"
              >
                <defs>
                  <DegradadoBarra id={GRAD_BARRA} color={SLOTS[0]} horizontal />
                </defs>
                <CartesianGrid stroke={VIZ_GRID} horizontal={false} />
                <XAxis type="number" tickFormatter={fmtEje} {...ejeValor} />
                <YAxis
                  type="category"
                  dataKey="clave"
                  width={124}
                  tickFormatter={(v: string) => acortar(v, 17)}
                  {...ejeCategoria}
                />
                <Tooltip
                  cursor={CURSOR_BANDA}
                  content={({ active, payload }) => {
                    const punto = payload?.[0]?.payload as PuntoAgrupado | undefined;
                    if (!active || !punto) return null;
                    return (
                      <CajaTooltip
                        titulo={nombreDimension ?? undefined}
                        filas={[
                          {
                            clave: punto.clave,
                            etiqueta: punto.clave,
                            color: SLOTS[0],
                            valor: fmtValor(punto.valor),
                          },
                        ]}
                      />
                    );
                  }}
                />
                {/* Una sola serie ⇒ un solo color. Un degradado por valor
                    duplicaría el largo de la barra en el tono y gastaría el
                    único canal libre —el de aquí corre dentro de CADA barra, así
                    que todas se ven igual. Sin leyenda: el título nombra la
                    serie. */}
                <Bar
                  dataKey="valor"
                  fill={`url(#${GRAD_BARRA})`}
                  maxBarSize={20}
                  radius={[0, 3, 3, 0]}
                  animationDuration={VIZ_ANIM}
                >
                  <LabelList
                    dataKey="valor"
                    position="right"
                    formatter={(v: unknown) => fmtValorCompacto(comoNumero(v))}
                    style={{
                      fill: "var(--cr-ink-2)",
                      fontSize: 10.5,
                      fontFamily: "var(--cr-font-mono)",
                    }}
                  />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Panel>

        {composicionValida ? (
          <Panel
            title={`Participación por ${nombreDimension}`}
            acciones={
              <div className="cr-viz-head">
                <span className="cr-viz-head__valor">{fmtValor(totalComposicion)}</span>
              </div>
            }
          >
            <p className="cr-viz-sub">
              Top {nTopComposicion} sobre el total
              {agregacion === "promedio" ? " (siempre suma: un promedio no es aditivo)" : ""}
            </p>
            <ParticipacionDona
              puntos={datosComposicion}
              total={totalComposicion}
              fmtValor={fmtValor}
              fmtValorCompacto={fmtValorCompacto}
            />
          </Panel>
        ) : null}
      </div>
    </div>
  );
}

export default memo(AnalisisChartsBase);
