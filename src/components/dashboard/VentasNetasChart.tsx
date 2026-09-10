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
  Delta,
  ejeValor,
  Leyenda,
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
  formatearPorcentajeConSigno,
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

/** Una casilla con el MISMO mes del año anterior al lado. */
export interface CasillaComparada extends Casilla {
  /** El mismo mes del año anterior. null = ese mes no se reportó. */
  previo: number | null;
}

export interface Comparativa {
  anioPrevio: number;
  /** Siempre 12, igual que casillasDelAnio: el eje no cambia de forma. */
  filas: CasillaComparada[];
  /** Meses con dato en LOS DOS años; es la base de los totales. */
  mesesComparables: number;
  /** null —no 0— cuando no hay meses compartidos: sin base, "—". */
  totalActual: number | null;
  totalPrevio: number | null;
  /** Fracción (1 = +100%); null si no hay base positiva. */
  variacion: number | null;
  /** ¿El año anterior tiene aunque sea un mes? Decide si el interruptor sirve. */
  hayPrevio: boolean;
}

/**
 * Los dos años en las mismas doce casillas, más los totales comparables.
 *
 * Los totales cuentan **sólo los meses con dato en LOS DOS años**. La regla es
 * de `compararAnios` (lib/retail/analisis/agregar.ts), y su docblock explica por
 * qué: comparar doce meses del año pasado contra los cuatro que van del actual
 * "daría una caída del 70% que no es tal, y es justo el número que alguien
 * copiaría a un correo". El guardia de la variación es el mismo de allá:
 * `totalPrevio > 0`, estrictamente, para no devolver un ∞ ni un signo al revés.
 *
 * Se replica en vez de reusar aquella función por dos razones. Recibe un
 * `Map<string, Acumulador>` y habría que falsificarle el `conteo` —el `total` de
 * un mes ya es la suma de hasta cuatro retailers, no 1—, lo que sólo es correcto
 * con agregación "suma" y silenciosamente falso con "promedio". Y sus `puntos`
 * SALTAN los meses ausentes en los dos años, mientras aquí el eje son doce
 * casillas fijas (ver casillasDelAnio).
 *
 * El año comparado es estrictamente `anio - 1`, y ahí también diverge:
 * `compararAnios` elige *los dos años presentes* para saltarse huecos del
 * histórico. Aquí no puede, porque la etiqueta del interruptor nombra ese año.
 *
 * Nunca devuelve null: el llamador necesita `hayPrevio` justamente en el caso en
 * que no hay nada que comparar, para deshabilitar el interruptor.
 */
export function compararConAnioAnterior(
  serie: PuntoVentasNetas[],
  anio: number
): Comparativa {
  const actuales = casillasDelAnio(serie, anio);
  const previas = casillasDelAnio(serie, anio - 1);
  const filas: CasillaComparada[] = actuales.map((c, i) => ({
    ...c,
    previo: previas[i].total,
  }));

  let sumaActual = 0;
  let sumaPrevio = 0;
  let mesesComparables = 0;
  for (const f of filas) {
    // `typeof === "number"` y no verdad/falsedad: un mes de cero ventas real
    // es un mes comparable, y con `if (f.total && f.previo)` se caería.
    if (typeof f.total !== "number" || typeof f.previo !== "number") continue;
    sumaActual += f.total;
    sumaPrevio += f.previo;
    mesesComparables++;
  }

  const hayBase = mesesComparables > 0;
  return {
    anioPrevio: anio - 1,
    filas,
    mesesComparables,
    // null y no 0 sin meses compartidos, igual que `totalAnio`: no hay total
    // que enseñar, y un "$0" diría que no se vendió nada.
    totalActual: hayBase ? sumaActual : null,
    totalPrevio: hayBase ? sumaPrevio : null,
    variacion: hayBase && sumaPrevio > 0 ? (sumaActual - sumaPrevio) / sumaPrevio : null,
    hayPrevio: previas.some((c) => typeof c.total === "number"),
  };
}

/** Variación de UN mes, para el tooltip. Mismo guardia que los totales. */
export function variacionMes(fila: CasillaComparada): number | null {
  if (typeof fila.total !== "number" || typeof fila.previo !== "number") return null;
  return fila.previo > 0 ? (fila.total - fila.previo) / fila.previo : null;
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
        // línea del año anterior cuando se compara, o del propio trazo, y
        // sin el halo se lee encima de ellas.
        // `paintOrder` pinta el contorno ANTES del relleno, así que el grosor
        // no engorda la letra.
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

export function VentasNetasChart({ datos }: { datos: VentasNetas }) {
  const [anio, setAnio] = useState(datos.anioActual);
  const [comparar, setComparar] = useState(false);

  // Se arma SIEMPRE, comparando o no: una CasillaComparada es una Casilla, así
  // que el camino sin comparación no se entera de la clave de más y hay una
  // sola estructura en vez de dos ramas.
  const comparativa = useMemo(
    () => compararConAnioAnterior(datos.serie, anio),
    [datos.serie, anio]
  );
  const casillas = comparativa.filas;
  const rangos = useMemo(() => rangosPorRetailer(datos.serie), [datos.serie]);

  const conDato = casillas.filter((c) => typeof c.total === "number");
  const ultimo = conDato.at(-1);

  // El índice sobre las DOCE casillas y no sobre las que tienen dato: es el que
  // recharts le pasa al renderer del punto.
  const iUltimo = ultimo ? casillas.findIndex((c) => c.periodo === ultimo.periodo) : -1;

  // Total del año elegido. `null` y no 0 cuando no hay un solo mes reportado:
  // un "Ventas totales de 2027: $0" diría que no se vendió nada, cuando lo que
  // pasa es que todavía no llega ningún reporte. Sin base, "—" (§8.1).
  const totalAnio =
    conDato.length > 0 ? conDato.reduce((t, c) => t + (c.total ?? 0), 0) : null;

  // Dos derivados y ningún useEffect: `comparar` guarda la INTENCIÓN y
  // `comparando` es lo que de verdad se dibuja. Se exige `conDato` además del
  // año anterior, o el interruptor sería un no-op detrás del estado vacío.
  const puedeComparar = comparativa.hayPrevio && conDato.length > 0;
  const comparando = comparar && puedeComparar;

  const razonSinComparar = !comparativa.hayPrevio
    ? `No hay ventas registradas de ${comparativa.anioPrevio}`
    : "No hay ventas registradas en el año seleccionado";

  const controles = (
    // .cr-panel__head es flex sin gap ni wrap, así que dos controles sueltos se
    // pegarían y nunca bajarían de renglón. El selector va primero: se lee como
    // frase ("2026 · Comparar con 2025") y al envolver baja el secundario.
    <div className="flex flex-wrap items-center gap-2">
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

      {/* Deshabilitado y no oculto: un control que desaparece al pasear por los
          años hace saltar la cabecera y no enseña nada; el title dice por qué.
          Se pinta `comparando` —el derivado— y no `comparar`: al caer en un año
          sin comparación posible la casilla se desmarca sola, en vez de quedar
          marcada sin línea fantasma en pantalla, que sería el control mintiendo
          sobre lo que está dibujado. La intención no se pierde: al volver a un
          año comparable se remarca. La etiqueta envolvente ya da el nombre
          accesible, así que aquí no va aria-label. */}
      <label className="cr-check" title={puedeComparar ? undefined : razonSinComparar}>
        <input
          type="checkbox"
          checked={comparando}
          disabled={!puedeComparar}
          onChange={(e) => setComparar(e.target.checked)}
        />
        Comparar con {comparativa.anioPrevio}
      </label>
    </div>
  );

  return (
    // El título NO cambia al comparar: un título que se voltea con un
    // interruptor es un evento visual mayor que el cambio que describe, y el
    // subtítulo más la leyenda ya nombran los dos años.
    <Panel title="Ventas netas del año" acciones={controles}>
      {/* Sale del mismo estado que la gráfica y no del año en curso, así que
          cambiar el filtro lo mueve con ella: el subtítulo nunca puede quedar
          nombrando un año distinto al que está dibujado. */}
      <p className="cr-viz-sub flex flex-wrap items-center gap-2">
        {!comparando ? (
          <span>
            Ventas netas de {anio}: {totalAnio === null ? "—" : formatearMoneda(totalAnio)}
          </span>
        ) : comparativa.mesesComparables > 0 ? (
          <>
            {/* La cláusula "sobre los N meses…" no se abrevia: al prender el
                interruptor la cifra del año actual pasa a ser la de los meses
                COMPARTIDOS, que difiere del total del año cuando el anterior
                tiene un hueco. Decir el alcance es lo que hace legítimo ese
                cambio. Por lo mismo no se enseñan las dos cifras juntas. */}
            <span>
              {formatearMoneda(comparativa.totalActual ?? 0)} en {anio} vs{" "}
              {formatearMoneda(comparativa.totalPrevio ?? 0)} en {comparativa.anioPrevio}, sobre
              los {comparativa.mesesComparables}{" "}
              {comparativa.mesesComparables === 1 ? "mes" : "meses"} que tienen los dos años
            </span>
            {/* Se oculta el badge entero cuando no hay variación, en vez de
                pintar un "—": mismo criterio que la comparativa de la ficha. */}
            {comparativa.variacion !== null ? (
              <Delta
                fraccion={comparativa.variacion}
                texto={formatearPorcentajeConSigno(comparativa.variacion)}
              />
            ) : null}
          </>
        ) : (
          <span>
            Ventas netas de {anio}: {totalAnio === null ? "—" : formatearMoneda(totalAnio)}.{" "}
            {anio} y {comparativa.anioPrevio} no comparten ningún mes, así que no hay total que
            comparar.
          </span>
        )}
      </p>

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
        <>
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
                  const punto = payload?.[0]?.payload as CasillaComparada | undefined;
                  if (!punto) return null;

                  if (comparando) {
                    // Se rinde sólo si faltan LOS DOS: un mes que este año
                    // todavía no llega pero el pasado sí tuvo muestra una fila
                    // sola. El tooltip no inventa un cero.
                    if (typeof punto.total !== "number" && typeof punto.previo !== "number") {
                      return null;
                    }
                    // El año actual arriba y el anterior debajo: lo que se
                    // está mirando es el año elegido, y el pasado es contra qué
                    // medirlo. La leyenda enumera en este mismo orden.
                    // Los colores son los de los trazos.
                    const filasAnios: FilaViz[] = [];
                    if (typeof punto.total === "number") {
                      filasAnios.push({
                        clave: "actual",
                        etiqueta: String(anio),
                        color: "var(--cr-ink)",
                        valor: formatearMoneda(punto.total),
                      });
                    }
                    if (typeof punto.previo === "number") {
                      filasAnios.push({
                        clave: "previo",
                        etiqueta: String(comparativa.anioPrevio),
                        color: "var(--cr-ink-3)",
                        valor: formatearMoneda(punto.previo),
                      });
                    }
                    const variacion = variacionMes(punto);
                    return (
                      <CajaTooltip
                        // El mes a secas y no "marzo de 2026": nombrar uno de
                        // los dos años en la cabecera de una caja que contiene
                        // los dos sería mentir sobre el alcance.
                        titulo={formatearMesCorto(punto.mes)}
                        filas={filasAnios}
                        // Texto plano y no un badge <Delta>: un pill de color
                        // sería el primer fondo coloreado dentro de la caja y
                        // competiría con los puntos de las filas.
                        total={
                          variacion === null
                            ? undefined
                            : {
                                clave: "variacion",
                                etiqueta: "Variación",
                                valor: formatearPorcentajeConSigno(variacion),
                              }
                        }
                      />
                    );
                  }

                  if (typeof punto.total !== "number") return null;

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
              {/* El año anterior va DESPUÉS del área y ANTES de la línea de
                  tinta. Debajo del área, el lavado al 14% lo teñiría donde se
                  traslapan y parecería cambiar de tono a lo largo; aquí
                  conserva un tono constante y el año actual siempre le cruza
                  por encima, que es el orden correcto de figura y fondo.

                  Gris y no un tono de --viz-*: esa paleta identifica
                  RETAILERS, y el año anterior no es otra categoría sino la
                  misma medida en otro tiempo. Tinta clara contra tinta plena
                  separa por luminosidad, el canal que sobrevive al daltonismo.

                  Sin animación: una referencia no se dibuja con
                  fanfarria. */}
              {comparando ? (
                <Line
                  type="monotone"
                  dataKey="previo"
                  name={String(comparativa.anioPrevio)}
                  stroke="var(--cr-ink-3)"
                  strokeWidth={1.5}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  dot={false}
                  activeDot={{ r: 3, strokeWidth: 2, stroke: VIZ_SUPERFICIE }}
                  connectNulls={false}
                  isAnimationActive={false}
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

          {/* Fuera del div de altura fija, o la leyenda le robaría alto a la
              gráfica o quedaría recortada.

              Sólo al comparar: con una sola serie no hay nada que distinguir
              por color y el título ya la nombra. Cuadrito y año, SIN cifras —el
              subtítulo ya carga los números, y repetirlos aquí con otra
              precisión, que es lo que hace la comparativa de la ficha, pone el
              mismo dato dos veces redondeado distinto en un mismo panel. */}
          {comparando ? (
            <Leyenda
              // Mismo orden que el tooltip: el año actual primero. Si los dos
              // enumeraran distinto, el ojo tendría que releer cuál es cuál en
              // cada salto entre la leyenda y la caja.
              items={[
                { clave: "actual", etiqueta: String(anio), color: "var(--cr-ink)" },
                {
                  clave: "previo",
                  etiqueta: String(comparativa.anioPrevio),
                  color: "var(--cr-ink-3)",
                },
              ]}
            />
          ) : null}
        </>
      )}
    </Panel>
  );
}
