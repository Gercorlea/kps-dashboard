'use client'

// El ÚNICO archivo que importa recharts. Se carga como chunk aparte con
// next/dynamic desde ventas-cliente.tsx, así que nada de esto entra al bundle
// hasta que el usuario carga un archivo.
//
// No hace ningún cálculo: recibe arreglos ya agregados (<=200 puntos) por props.
import { memo } from 'react'
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
} from 'recharts'
import { OTROS } from '@/lib/excel/agregar'
import {
  formatearClaveTemporal,
  formatearCompacto,
  formatearEntero,
  formatearNumero,
  formatearPorcentaje,
} from '@/lib/excel/formato'
import type { Agregacion, Granularidad, PuntoAgrupado, PuntoSerie } from '@/lib/excel/tipos'

// El orden de los slots es el mecanismo de seguridad para daltonismo, no
// decoración. Nunca ciclar ni generar un séptimo tono: el excedente se pliega
// en "Otros" aguas arriba.
const SLOTS = [
  'var(--viz-1)',
  'var(--viz-2)',
  'var(--viz-3)',
  'var(--viz-4)',
  'var(--viz-5)',
  'var(--viz-6)',
]

const SLOT_OTROS = SLOTS[5]

const ESTILO_TOOLTIP = {
  backgroundColor: 'var(--viz-surface)',
  border: '1px solid var(--viz-axis)',
  borderRadius: '6px',
  fontSize: '12px',
}

const ESTILO_TICK = { fill: 'var(--viz-muted)', fontSize: 11 }

type Props = {
  datosBarra: PuntoAgrupado[]
  datosSerie: PuntoSerie[] | null
  datosComposicion: PuntoAgrupado[]
  nombreDimension: string | null
  nombreMetrica: string
  agregacion: Agregacion
  granularidad: Granularidad
}

const ETIQUETA_PERIODO: Record<Granularidad, string> = {
  dia: 'día',
  mes: 'mes',
  anio: 'año',
}

const ETIQUETA_AGREGACION: Record<Agregacion, string> = {
  suma: 'Total',
  promedio: 'Promedio',
  conteo: 'Cantidad',
}

function Tarjeta({
  titulo,
  nota,
  alto,
  pie,
  children,
}: {
  titulo: string
  nota?: string
  alto: string
  pie?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="flex flex-col gap-1 rounded-lg border border-black/10 p-4 dark:border-white/10">
      <h3 className="text-sm font-semibold">{titulo}</h3>
      {nota && <p className="text-xs text-zinc-600 dark:text-zinc-400">{nota}</p>}
      {/* Altura explícita: ResponsiveContainer necesita un padre medible, y el
          margen inferior del chart deja caber la banda del eje X. */}
      <div className={`mt-2 w-full ${alto}`}>{children}</div>
      {pie}
    </section>
  )
}

/**
 * Leyenda en HTML plano en vez del <Legend> de Recharts: la versión 3 quitó la
 * prop `payload`, con lo que no hay forma de fijar el orden y la librería los
 * ordena alfabéticamente, desalineando la leyenda de los segmentos.
 *
 * El texto va en tinta, nunca en el color de la serie: el cuadrito ya lleva la
 * identidad.
 */
function LeyendaComposicion({ puntos }: { puntos: LeyendaItem[] }) {
  return (
    <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
      {puntos.map((p) => (
        <li key={p.clave} className="flex items-center gap-1.5 text-xs">
          <span
            aria-hidden="true"
            className="size-2.5 shrink-0 rounded-xs"
            style={{ backgroundColor: p.color }}
          />
          <span className="text-zinc-700 dark:text-zinc-300">{p.etiqueta}</span>
          <span className="text-zinc-500 tabular-nums dark:text-zinc-500">{p.porcentaje}</span>
        </li>
      ))}
    </ul>
  )
}

type LeyendaItem = { clave: string; etiqueta: string; color: string; porcentaje: string }

function acortar(texto: string, max = 24): string {
  return texto.length > max ? `${texto.slice(0, max - 1)}…` : texto
}

// Recharts tipa los valores que pasa a los formatters como ValueType | undefined
// (puede ser string, número o arreglo). Se estrechan aquí en vez de repetir
// castings en cada callback.
function comoNumero(v: unknown): number {
  return typeof v === 'number' ? v : Number(v)
}

function comoTexto(v: unknown): string {
  return v === null || v === undefined ? '' : String(v)
}

function PanelGraficos({
  datosBarra,
  datosSerie,
  datosComposicion,
  nombreDimension,
  nombreMetrica,
  agregacion,
  granularidad,
}: Props) {
  const hayDimension = nombreDimension !== null && datosBarra.length > 0
  // Participación sólo tiene sentido con magnitudes aditivas y positivas: con
  // valores negativos un 100% apilado miente. En ese caso no se dibuja.
  const totalComposicion = datosComposicion.reduce((s, p) => s + p.valor, 0)
  const composicionValida =
    datosComposicion.length > 1 &&
    totalComposicion > 0 &&
    datosComposicion.every((p) => p.valor >= 0)
  const filaComposicion: Record<string, number | string> = { etiqueta: 'total' }
  if (composicionValida) {
    for (const p of datosComposicion) filaComposicion[p.clave] = p.valor
  }
  const colorSegmento = (clave: string, i: number) => (clave === OTROS ? SLOT_OTROS : SLOTS[i])
  const leyendaComposicion: LeyendaItem[] = datosComposicion.map((p, i) => ({
    clave: p.clave,
    etiqueta:
      p.gruposPlegados !== undefined
        ? `${p.clave} (${formatearEntero(p.gruposPlegados)} grupos)`
        : acortar(p.clave, 28),
    color: colorSegmento(p.clave, i),
    porcentaje: totalComposicion > 0 ? formatearPorcentaje(p.valor / totalComposicion) : '',
  }))
  // "Otros" no es un puesto del top: es lo que quedó fuera.
  const nTop = datosBarra.filter((p) => p.clave !== OTROS).length
  const nTopComposicion = datosComposicion.filter((p) => p.clave !== OTROS).length
  return (
    <div className="flex flex-col gap-4">
      {hayDimension ? (
        <Tarjeta
          titulo={`Top ${nTop} por ${nombreDimension}`}
          nota={`${ETIQUETA_AGREGACION[agregacion]} de ${nombreMetrica.toLowerCase()}`}
          alto="h-96"
        >
          <ResponsiveContainer width="100%" height="100%" debounce={50}>
            <BarChart
              data={datosBarra}
              layout="vertical"
              margin={{ top: 4, right: 64, bottom: 24, left: 8 }}
            >
              <CartesianGrid horizontal={false} stroke="var(--viz-grid)" />
              <XAxis
                type="number"
                tickFormatter={formatearCompacto}
                tick={ESTILO_TICK}
                stroke="var(--viz-axis)"
              />
              <YAxis
                type="category"
                dataKey="clave"
                width={170}
                tickFormatter={(v: string) => acortar(v)}
                tick={ESTILO_TICK}
                stroke="var(--viz-axis)"
              />
              <Tooltip
                cursor={{ fill: 'var(--viz-grid)', fillOpacity: 0.4 }}
                contentStyle={ESTILO_TOOLTIP}
                formatter={(v: unknown) =>
                  [formatearNumero(comoNumero(v)), nombreMetrica] as [string, string]
                }
              />
              {/* Una sola serie ⇒ un solo color. Un degradado por valor
                  duplicaría el largo de la barra en el tono. Sin leyenda: el
                  título ya nombra la serie. */}
              <Bar
                dataKey="valor"
                fill="var(--viz-1)"
                maxBarSize={24}
                radius={[0, 4, 4, 0]}
                isAnimationActive={false}
              >
                <LabelList
                  dataKey="valor"
                  position="right"
                  formatter={(v: unknown) => formatearCompacto(comoNumero(v))}
                  style={{ fill: 'var(--viz-muted)', fontSize: 11 }}
                />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </Tarjeta>
      ) : (
        <p className="rounded-lg border border-black/10 p-4 text-sm text-zinc-600 dark:border-white/10 dark:text-zinc-400">
          No se detectaron columnas para agrupar, así que no hay gráficas por categoría.
        </p>
      )}
      {datosSerie && datosSerie.length > 1 && (
        <Tarjeta
          titulo={`${nombreMetrica} por ${ETIQUETA_PERIODO[granularidad]}`}
          nota={`${ETIQUETA_AGREGACION[agregacion]}; los periodos sin datos se muestran en cero`}
          alto="h-80"
        >
          <ResponsiveContainer width="100%" height="100%" debounce={50}>
            <LineChart data={datosSerie} margin={{ top: 8, right: 24, bottom: 24, left: 8 }}>
              <CartesianGrid vertical={false} stroke="var(--viz-grid)" />
              <XAxis
                dataKey="clave"
                tickFormatter={formatearClaveTemporal}
                tick={ESTILO_TICK}
                stroke="var(--viz-axis)"
                minTickGap={24}
              />
              <YAxis
                tickFormatter={formatearCompacto}
                tick={ESTILO_TICK}
                stroke="var(--viz-axis)"
              />
              <Tooltip
                contentStyle={ESTILO_TOOLTIP}
                labelFormatter={(v: unknown) => formatearClaveTemporal(comoTexto(v))}
                formatter={(v: unknown) =>
                  [formatearNumero(comoNumero(v)), nombreMetrica] as [string, string]
                }
              />
              <Line
                type="monotone"
                dataKey="valor"
                stroke="var(--viz-1)"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                dot={false}
                activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--viz-surface)' }}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </Tarjeta>
      )}
      {hayDimension && composicionValida && (
        <Tarjeta
          titulo={`Participación por ${nombreDimension}`}
          nota={`Top ${nTopComposicion} sobre el total${
            agregacion === 'promedio' ? ' (siempre suma: un promedio no es aditivo)' : ''
          }`}
          alto="h-14"
          pie={<LeyendaComposicion puntos={leyendaComposicion} />}
        >
          <ResponsiveContainer width="100%" height="100%" debounce={50}>
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
                  const n = comoNumero(v)
                  return [
                    `${formatearNumero(n)} · ${formatearPorcentaje(n / totalComposicion)}`,
                    acortar(comoTexto(nombre), 28),
                  ] as [string, string]
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
                  stroke="var(--viz-surface)"
                  strokeWidth={2}
                  isAnimationActive={false}
                  radius={
                    i === 0
                      ? [4, 0, 0, 4]
                      : i === datosComposicion.length - 1
                        ? [0, 4, 4, 0]
                        : undefined
                  }
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </Tarjeta>
      )}
    </div>
  )
}

export default memo(PanelGraficos)
