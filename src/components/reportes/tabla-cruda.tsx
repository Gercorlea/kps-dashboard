import { memo } from 'react'
import { formatearCelda, formatearEntero } from '@/lib/excel/formato'
import type { FilaCruda, MetaColumna } from '@/lib/excel/tipos'

// Un archivo muy ancho no aporta nada tras las primeras decenas de columnas y
// multiplica el DOM: se recorta y se avisa.
export const MAX_COLUMNAS = 60

type Props = {
  columnas: MetaColumna[]
  filasVisibles: FilaCruda[]
  totalFilas: number
  hoja: string
  filaEncabezado: number
}

function TablaCruda({ columnas, filasVisibles, totalFilas, hoja, filaEncabezado }: Props) {
  const visibles = columnas.slice(0, MAX_COLUMNAS)

  const leyenda = [
    `Mostrando ${formatearEntero(filasVisibles.length)} de ${formatearEntero(totalFilas)} filas`,
    `hoja «${hoja}»`,
    // Se expone la detección de encabezado para que un acierto dudoso sea
    // visible en pantalla en vez de silencioso.
    filaEncabezado >= 0
      ? `encabezado detectado en la fila ${filaEncabezado + 1}`
      : 'sin encabezado detectado',
    columnas.length > MAX_COLUMNAS
      ? `mostrando ${MAX_COLUMNAS} de ${formatearEntero(columnas.length)} columnas`
      : null,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <section aria-labelledby="titulo-tabla" className="flex flex-col gap-3">
      <h2 id="titulo-tabla" className="text-base font-semibold">
        Datos en crudo
      </h2>

      <div className="max-h-[32rem] overflow-auto rounded-lg border border-black/10 dark:border-white/10">
        <table className="w-full border-collapse text-sm">
          <caption className="caption-bottom px-3 py-2 text-left text-xs text-zinc-600 dark:text-zinc-400">
            {leyenda}. Las gráficas se calculan sobre las {formatearEntero(totalFilas)} filas
            completas.
          </caption>
          <thead className="sticky top-0 z-10 bg-zinc-50 dark:bg-zinc-900">
            <tr>
              {visibles.map((col) => (
                <th
                  key={col.indice}
                  scope="col"
                  className="max-w-96 truncate border-b border-black/10 px-3 py-2 text-left font-medium whitespace-nowrap dark:border-white/10"
                  title={col.nombre}
                >
                  {col.nombre}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filasVisibles.map((fila, i) => (
              <tr key={i} className="odd:bg-black/[0.02] dark:odd:bg-white/[0.03]">
                {visibles.map((col) => {
                  const texto = formatearCelda(fila[col.indice])
                  return (
                    <td
                      key={col.indice}
                      title={texto}
                      className={`max-w-96 truncate px-3 py-1.5 whitespace-nowrap ${
                        col.tipo === 'numero' ? 'text-right tabular-nums' : ''
                      }`}
                    >
                      {texto}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

// Cambiar un selector de gráficas no debe rerenderizar la tabla.
export default memo(TablaCruda)
