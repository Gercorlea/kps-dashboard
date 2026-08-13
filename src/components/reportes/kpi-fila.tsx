import { memo } from 'react'
import { formatearCompacto, formatearEntero, formatearFecha } from '@/lib/excel/formato'
import type { Kpis } from '@/lib/excel/tipos'

type Props = {
  kpis: Kpis
  nombreMetrica: string
  nombreDimension: string | null
}

function Tile({
  etiqueta,
  valor,
  tamano = 'normal',
}: {
  etiqueta: string
  valor: string
  tamano?: 'hero' | 'normal' | 'texto'
}) {
  const escala =
    tamano === 'hero' ? 'text-5xl' : tamano === 'texto' ? 'text-base' : 'text-2xl'
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-black/10 px-4 py-3 dark:border-white/10">
      <span className="text-xs text-zinc-600 dark:text-zinc-400">{etiqueta}</span>
      {/* Cifras proporcionales en el número grande; tabular-nums se reserva
          para columnas que deben alinearse verticalmente. */}
      <span className={`${escala} font-semibold`}>{valor}</span>
    </div>
  )
}

function KpiFila({ kpis, nombreMetrica, nombreDimension }: Props) {
  const { rangoFechas } = kpis

  return (
    // Un solo hero por vista: el total de la métrica.
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Tile
        etiqueta={`Total ${nombreMetrica.toLowerCase()}`}
        valor={formatearCompacto(kpis.totalMetrica)}
        tamano="hero"
      />
      <Tile etiqueta="Filas cargadas" valor={formatearEntero(kpis.totalFilas)} />
      {nombreDimension && (
        <Tile
          etiqueta={`${nombreDimension} distintos`}
          valor={formatearEntero(kpis.dimensionesDistintas)}
        />
      )}
      {rangoFechas && (
        <Tile
          etiqueta="Rango de fechas"
          valor={`${formatearFecha(rangoFechas.desde)} – ${formatearFecha(rangoFechas.hasta)}`}
          tamano="texto"
        />
      )}
    </div>
  )
}

export default memo(KpiFila)
