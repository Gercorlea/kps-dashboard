'use client'

// Único punto de entrada de cliente de la ruta: aquí vive todo el estado y
// todas las agregaciones memoizadas. Los componentes que renderiza no necesitan
// su propia directiva 'use client' — entran al bundle de cliente por ser
// importados desde aquí.

import dynamic from 'next/dynamic'
import { useCallback, useMemo, useRef, useState } from 'react'
import CargadorExcel from './cargador-excel'
import KpiFila from './kpi-fila'
import TablaCruda from './tabla-cruda'
import { agrupar, calcularKpis, granularidadAuto, serieTemporal } from '@/lib/excel/agregar'
import {
  columnasDimension,
  columnasMetrica,
  elegirDimension,
  elegirFecha,
  elegirMetrica,
} from '@/lib/excel/inferir-tipos'
import {
  construirDataset,
  elegirHojaConDatos,
  ErrorExcel,
  leerLibro,
  LIMITE_AVISO_BYTES,
} from '@/lib/excel/parsear'
import { METRICA_CONTEO } from '@/lib/excel/tipos'
import type { Agregacion, Dataset, Granularidad, HojaCruda } from '@/lib/excel/tipos'

// Recharts (con Redux y d3 detrás) es lo más pesado de la ruta y no sirve de
// nada hasta que hay un archivo cargado. ssr:false porque ResponsiveContainer
// mide el DOM: el render de servidor sería una caja vacía que luego reflowea.
// La llamada va a nivel de módulo y con ruta literal, como exige next/dynamic.
const PanelGraficos = dynamic(() => import('./panel-graficos'), {
  ssr: false,
  loading: () => <EsqueletoGraficos />,
})

const FILAS_VISIBLES = 100
const TOP_BARRA = 8
const TOP_COMPOSICION = 5

type Estado = 'inactivo' | 'leyendo' | 'listo' | 'error'

export default function VentasCliente() {
  const [estado, setEstado] = useState<Estado>('inactivo')
  const [mensajeError, setMensajeError] = useState<string | null>(null)
  const [aviso, setAviso] = useState<string | null>(null)
  const [nombreArchivo, setNombreArchivo] = useState<string | null>(null)

  // Las hojas crudas viven fuera del estado: cambiar de hoja no debe obligar a
  // React a reconciliar un objeto de varios megabytes.
  const hojasRef = useRef<HojaCruda[] | null>(null)
  const [nombresHojas, setNombresHojas] = useState<string[]>([])
  const [hojaActual, setHojaActual] = useState<string>('')

  const [dataset, setDataset] = useState<Dataset | null>(null)
  const [idxDimension, setIdxDimension] = useState(-1)
  const [idxMetrica, setIdxMetrica] = useState(METRICA_CONTEO)
  const [idxFecha, setIdxFecha] = useState(-1)
  const [agregacion, setAgregacion] = useState<Agregacion>('suma')
  const [granManual, setGranManual] = useState<Granularidad | null>(null)

  const aplicarDataset = useCallback((ds: Dataset) => {
    setDataset(ds)
    setHojaActual(ds.hoja)
    setIdxDimension(elegirDimension(ds.columnas))
    const met = elegirMetrica(ds.columnas)
    setIdxMetrica(met)
    setIdxFecha(elegirFecha(ds.columnas))
    setAgregacion(met === METRICA_CONTEO ? 'conteo' : 'suma')
    setGranManual(null)
    setMensajeError(null)
    setEstado('listo')
  }, [])

  const alArchivo = useCallback(
    async (file: File) => {
      setEstado('leyendo')
      setMensajeError(null)
      setNombreArchivo(file.name)
      setAviso(
        file.size > LIMITE_AVISO_BYTES
          ? `El archivo pesa ${Math.round(file.size / 1024 / 1024)} MB; el análisis puede tardar unos segundos.`
          : null,
      )

      // setEstado por sí solo no pinta el spinner: React batchea la
      // actualización y el parseo bloquea el mismo frame que lo habría
      // dibujado. Hay que cederle el hilo al navegador primero.
      await new Promise((r) => requestAnimationFrame(() => r(null)))

      try {
        const t0 = performance.now()
        const hojas = await leerLibro(file)
        const ds = construirDataset(hojas, elegirHojaConDatos(hojas))
        hojasRef.current = hojas
        setNombresHojas(hojas.map((h) => h.nombre))
        aplicarDataset(ds)
        if (process.env.NODE_ENV === 'development') {
          console.debug(
            `[reportes] parseo ${Math.round(performance.now() - t0)} ms · ${ds.totalFilas} filas`,
          )
        }
      } catch (error) {
        hojasRef.current = null
        setDataset(null)
        setNombresHojas([])
        setMensajeError(
          error instanceof ErrorExcel
            ? error.message
            : 'Ocurrió un error inesperado al leer el archivo.',
        )
        setEstado('error')
      }
    },
    [aplicarDataset],
  )

  const alCambiarHoja = useCallback(
    (nombre: string) => {
      const hojas = hojasRef.current
      if (!hojas) return
      setHojaActual(nombre)
      try {
        // Se re-deriva desde las hojas cacheadas; no se vuelve a leer el archivo.
        aplicarDataset(construirDataset(hojas, nombre))
      } catch (error) {
        setDataset(null)
        setMensajeError(
          error instanceof ErrorExcel ? error.message : 'No se pudo usar esa hoja.',
        )
        setEstado('error')
      }
    },
    [aplicarDataset],
  )

  // Referencias estables mientras el dataset no cambie: sirven como deps.
  const colDimension = dataset && idxDimension >= 0 ? dataset.columnas[idxDimension] : null
  const colMetrica = dataset && idxMetrica >= 0 ? dataset.columnas[idxMetrica] : null
  const colFecha = dataset && idxFecha >= 0 ? dataset.columnas[idxFecha] : null

  // Sin columna numérica no hay suma ni promedio posibles.
  const agregacionEfectiva: Agregacion = colMetrica ? agregacion : 'conteo'
  const nombreMetrica = colMetrica?.nombre ?? 'Cantidad de filas'

  const filasVisibles = useMemo(() => dataset?.filas.slice(0, FILAS_VISIBLES) ?? [], [dataset])

  const granEfectiva = useMemo<Granularidad>(() => {
    if (granManual) return granManual
    if (!dataset || !colFecha) return 'mes'
    return granularidadAuto(dataset.filas, colFecha)
  }, [granManual, dataset, colFecha])

  const datosBarra = useMemo(
    () =>
      dataset && colDimension
        ? agrupar(dataset.filas, colDimension, colMetrica, agregacionEfectiva, TOP_BARRA)
        : [],
    [dataset, colDimension, colMetrica, agregacionEfectiva],
  )

  // La participación se calcula SIEMPRE sobre la suma (o el conteo): un
  // promedio no es aditivo y su reparto porcentual no significa nada.
  const datosComposicion = useMemo(
    () =>
      dataset && colDimension
        ? agrupar(
            dataset.filas,
            colDimension,
            colMetrica,
            colMetrica ? 'suma' : 'conteo',
            TOP_COMPOSICION,
          )
        : [],
    [dataset, colDimension, colMetrica],
  )

  const datosSerie = useMemo(
    () =>
      dataset && colFecha
        ? serieTemporal(dataset.filas, colFecha, colMetrica, agregacionEfectiva, granEfectiva)
        : null,
    [dataset, colFecha, colMetrica, agregacionEfectiva, granEfectiva],
  )

  const kpis = useMemo(
    () => (dataset ? calcularKpis(dataset.filas, colDimension, colMetrica, colFecha) : null),
    [dataset, colDimension, colMetrica, colFecha],
  )

  const opcionesDimension = dataset ? columnasDimension(dataset.columnas) : []
  const opcionesMetrica = dataset ? columnasMetrica(dataset.columnas) : []

  return (
    <div className="flex flex-col gap-6">
      <CargadorExcel
        onArchivo={alArchivo}
        cargando={estado === 'leyendo'}
        nombreArchivo={nombreArchivo}
      />

      <p className="text-xs text-zinc-600 dark:text-zinc-400">
        El archivo se procesa en tu navegador y no se sube a ningún servidor. Al recargar la
        página se pierde.
      </p>

      {aviso && <p className="text-sm text-zinc-600 dark:text-zinc-400">{aviso}</p>}

      {mensajeError && (
        <div
          role="alert"
          className="flex items-start justify-between gap-4 rounded-lg border border-red-500/40 bg-red-500/5 px-4 py-3 text-sm"
        >
          <span>{mensajeError}</span>
          <button
            type="button"
            onClick={() => setMensajeError(null)}
            className="shrink-0 underline underline-offset-2"
          >
            Descartar
          </button>
        </div>
      )}

      {/* Una sola fila de filtros arriba de todo: cada gráfica, la tabla y los
          KPIs se recalculan contra la misma selección, así que los números
          siempre concuerdan entre sí. */}
      {(dataset || nombresHojas.length > 1) && (
        <div className="flex flex-wrap items-end gap-4">
          {nombresHojas.length > 1 && (
            <Selector etiqueta="Hoja" valor={hojaActual} onCambio={alCambiarHoja}>
              {nombresHojas.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Selector>
          )}

          {dataset && opcionesDimension.length > 0 && (
            <Selector
              etiqueta="Dimensión"
              valor={String(idxDimension)}
              onCambio={(v) => setIdxDimension(Number(v))}
            >
              {opcionesDimension.map((c) => (
                <option key={c.indice} value={c.indice}>
                  {c.nombre}
                </option>
              ))}
            </Selector>
          )}

          {dataset && (
            <Selector
              etiqueta="Métrica"
              valor={String(idxMetrica)}
              onCambio={(v) => setIdxMetrica(Number(v))}
            >
              <option value={METRICA_CONTEO}>Cantidad de filas</option>
              {opcionesMetrica.map((c) => (
                <option key={c.indice} value={c.indice}>
                  {c.nombre}
                </option>
              ))}
            </Selector>
          )}

          {dataset && colMetrica && (
            <Selector
              etiqueta="Agregación"
              valor={agregacion}
              onCambio={(v) => setAgregacion(v as Agregacion)}
            >
              <option value="suma">Suma</option>
              <option value="promedio">Promedio</option>
              <option value="conteo">Conteo</option>
            </Selector>
          )}

          {dataset && colFecha && (
            <Selector
              etiqueta="Granularidad"
              valor={granManual ?? granEfectiva}
              onCambio={(v) => setGranManual(v as Granularidad)}
            >
              <option value="dia">Día</option>
              <option value="mes">Mes</option>
              <option value="anio">Año</option>
            </Selector>
          )}
        </div>
      )}

      {dataset && kpis && (
        <>
          <KpiFila
            kpis={kpis}
            nombreMetrica={nombreMetrica}
            nombreDimension={colDimension?.nombre ?? null}
          />

          <TablaCruda
            columnas={dataset.columnas}
            filasVisibles={filasVisibles}
            totalFilas={dataset.totalFilas}
            hoja={dataset.hoja}
            filaEncabezado={dataset.filaEncabezado}
          />

          <PanelGraficos
            datosBarra={datosBarra}
            datosSerie={datosSerie}
            datosComposicion={datosComposicion}
            nombreDimension={colDimension?.nombre ?? null}
            nombreMetrica={nombreMetrica}
            agregacion={agregacionEfectiva}
            granularidad={granEfectiva}
          />
        </>
      )}
    </div>
  )
}

function Selector({
  etiqueta,
  valor,
  onCambio,
  children,
}: {
  etiqueta: string
  valor: string
  onCambio: (valor: string) => void
  children: React.ReactNode
}) {
  return (
    <label className="flex flex-col gap-1 text-xs text-zinc-600 dark:text-zinc-400">
      {etiqueta}
      <select
        value={valor}
        onChange={(e) => onCambio(e.target.value)}
        className="min-w-40 rounded-md border border-black/15 bg-background px-2 py-1.5 text-sm text-foreground dark:border-white/15"
      >
        {children}
      </select>
    </label>
  )
}

function EsqueletoGraficos() {
  return (
    <div className="flex flex-col gap-4" aria-hidden="true">
      <div className="h-96 animate-pulse rounded-lg border border-black/10 dark:border-white/10" />
      <div className="h-80 animate-pulse rounded-lg border border-black/10 dark:border-white/10" />
    </div>
  )
}
