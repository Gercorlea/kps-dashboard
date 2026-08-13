"use client";

// Único punto de entrada de cliente del analizador: aquí vive todo el estado y
// todas las agregaciones memoizadas. Los componentes que renderiza no necesitan
// su propia directiva "use client" — entran al bundle de cliente por ser
// importados desde aquí.

import dynamic from "next/dynamic";
import { useCallback, useMemo, useRef, useState } from "react";
import { AnalisisKpis } from "@/components/retail/AnalisisKpis";
import { AnalisisTable } from "@/components/retail/AnalisisTable";
import { AnalisisUploader } from "@/components/retail/AnalisisUploader";
import { EstadoVacio, Panel } from "@/components/ui/basicos";
import {
  agrupar,
  calcularKpis,
  granularidadAuto,
  serieTemporal,
} from "@/lib/retail/analisis/agregar";
import {
  columnasDimension,
  columnasMetrica,
  elegirDimension,
  elegirFecha,
  elegirMetrica,
} from "@/lib/retail/analisis/inferir-tipos";
import {
  construirDataset,
  elegirHojaConDatos,
  ErrorExcel,
  LIMITE_AVISO_BYTES,
  leerLibro,
} from "@/lib/retail/analisis/parsear";
import { METRICA_CONTEO } from "@/lib/retail/analisis/tipos";
import type {
  Agregacion,
  Dataset,
  Granularidad,
  HojaCruda,
} from "@/lib/retail/analisis/tipos";

// recharts (con redux y d3 detrás) es lo más pesado de la ruta y no sirve de
// nada hasta que hay un archivo cargado. ssr:false porque ResponsiveContainer
// mide el DOM: el render de servidor sería una caja vacía que luego reflowea.
// La llamada va a nivel de módulo y con ruta literal, como exige next/dynamic.
const AnalisisCharts = dynamic(() => import("@/components/retail/AnalisisCharts"), {
  ssr: false,
  loading: () => <EsqueletoGraficas />,
});

const FILAS_VISIBLES = 100;
const TOP_BARRA = 8;
const TOP_COMPOSICION = 5;

type Estado = "inactivo" | "leyendo" | "listo" | "error";

export function AnalisisExcel() {
  const [estado, setEstado] = useState<Estado>("inactivo");
  const [mensajeError, setMensajeError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [nombreArchivo, setNombreArchivo] = useState<string | null>(null);

  // Las hojas crudas viven fuera del estado: cambiar de hoja no debe obligar a
  // React a reconciliar un objeto de varios megabytes.
  const hojasRef = useRef<HojaCruda[] | null>(null);
  const [nombresHojas, setNombresHojas] = useState<string[]>([]);
  const [hojaActual, setHojaActual] = useState("");

  const [dataset, setDataset] = useState<Dataset | null>(null);
  const [idxDimension, setIdxDimension] = useState(-1);
  const [idxMetrica, setIdxMetrica] = useState(METRICA_CONTEO);
  const [idxFecha, setIdxFecha] = useState(-1);
  const [agregacion, setAgregacion] = useState<Agregacion>("suma");
  const [granManual, setGranManual] = useState<Granularidad | null>(null);

  const aplicarDataset = useCallback((ds: Dataset) => {
    setDataset(ds);
    setHojaActual(ds.hoja);
    setIdxDimension(elegirDimension(ds.columnas));
    const met = elegirMetrica(ds.columnas);
    setIdxMetrica(met);
    setIdxFecha(elegirFecha(ds.columnas));
    setAgregacion(met === METRICA_CONTEO ? "conteo" : "suma");
    setGranManual(null);
    setMensajeError(null);
    setEstado("listo");
  }, []);

  const alArchivo = useCallback(
    async (file: File) => {
      setEstado("leyendo");
      setMensajeError(null);
      setNombreArchivo(file.name);
      setAviso(
        file.size > LIMITE_AVISO_BYTES
          ? `El archivo pesa ${Math.round(file.size / 1024 / 1024)} MB; el análisis puede tardar unos segundos.`
          : null
      );

      // setEstado por sí solo no pinta el spinner: React batchea la
      // actualización y el parseo bloquea el mismo frame que lo habría
      // dibujado. Hay que cederle el hilo al navegador primero.
      await new Promise((r) => requestAnimationFrame(() => r(null)));

      try {
        const t0 = performance.now();
        const hojas = await leerLibro(file);
        const ds = construirDataset(hojas, elegirHojaConDatos(hojas));
        hojasRef.current = hojas;
        setNombresHojas(hojas.map((h) => h.nombre));
        aplicarDataset(ds);
        if (process.env.NODE_ENV === "development") {
          console.debug(
            `[analisis] parseo ${Math.round(performance.now() - t0)} ms · ${ds.totalFilas} filas`
          );
        }
      } catch (error) {
        hojasRef.current = null;
        setDataset(null);
        setNombresHojas([]);
        setMensajeError(
          error instanceof ErrorExcel
            ? error.message
            : "Ocurrió un error inesperado al leer el archivo."
        );
        setEstado("error");
      }
    },
    [aplicarDataset]
  );

  const alCambiarHoja = useCallback(
    (nombre: string) => {
      const hojas = hojasRef.current;
      if (!hojas) return;
      setHojaActual(nombre);
      try {
        // Se re-deriva desde las hojas cacheadas; no se relee el archivo.
        aplicarDataset(construirDataset(hojas, nombre));
      } catch (error) {
        setDataset(null);
        setMensajeError(
          error instanceof ErrorExcel ? error.message : "No se pudo usar esa hoja."
        );
        setEstado("error");
      }
    },
    [aplicarDataset]
  );

  // Referencias estables mientras el dataset no cambie: sirven como deps.
  const colDimension = dataset && idxDimension >= 0 ? dataset.columnas[idxDimension] : null;
  const colMetrica = dataset && idxMetrica >= 0 ? dataset.columnas[idxMetrica] : null;
  const colFecha = dataset && idxFecha >= 0 ? dataset.columnas[idxFecha] : null;

  // Sin columna numérica no hay suma ni promedio posibles.
  const agregacionEfectiva: Agregacion = colMetrica ? agregacion : "conteo";
  const nombreMetrica = colMetrica?.nombre ?? "Cantidad de filas";

  const filasVisibles = useMemo(
    () => dataset?.filas.slice(0, FILAS_VISIBLES) ?? [],
    [dataset]
  );

  const granEfectiva = useMemo<Granularidad>(() => {
    if (granManual) return granManual;
    if (!dataset || !colFecha) return "mes";
    return granularidadAuto(dataset.filas, colFecha);
  }, [granManual, dataset, colFecha]);

  const datosBarra = useMemo(
    () =>
      dataset && colDimension
        ? agrupar(dataset.filas, colDimension, colMetrica, agregacionEfectiva, TOP_BARRA)
        : [],
    [dataset, colDimension, colMetrica, agregacionEfectiva]
  );

  // La participación se calcula SIEMPRE sobre la suma (o el conteo): un
  // promedio no es aditivo y su reparto porcentual no significa nada.
  const datosComposicion = useMemo(
    () =>
      dataset && colDimension
        ? agrupar(
            dataset.filas,
            colDimension,
            colMetrica,
            colMetrica ? "suma" : "conteo",
            TOP_COMPOSICION
          )
        : [],
    [dataset, colDimension, colMetrica]
  );

  const datosSerie = useMemo(
    () =>
      dataset && colFecha
        ? serieTemporal(
            dataset.filas,
            colFecha,
            colMetrica,
            agregacionEfectiva,
            granEfectiva
          )
        : null,
    [dataset, colFecha, colMetrica, agregacionEfectiva, granEfectiva]
  );

  const kpis = useMemo(
    () => (dataset ? calcularKpis(dataset.filas, colDimension, colMetrica, colFecha) : null),
    [dataset, colDimension, colMetrica, colFecha]
  );

  const opcionesDimension = dataset ? columnasDimension(dataset.columnas) : [];
  const opcionesMetrica = dataset ? columnasMetrica(dataset.columnas) : [];

  return (
    <div className="flex flex-col gap-6">
      <AnalisisUploader
        onArchivo={alArchivo}
        cargando={estado === "leyendo"}
        nombreArchivo={nombreArchivo}
      />

      {aviso ? <p className="cr-small">{aviso}</p> : null}

      {mensajeError ? (
        <p className="cr-small" style={{ color: "var(--cr-danger)" }} role="alert">
          {mensajeError}
        </p>
      ) : null}

      {estado === "inactivo" && !mensajeError ? (
        <Panel>
          <EstadoVacio
            title="Sin archivo cargado"
            detalle="Sube un .xlsx para ver los datos en crudo y su análisis. Se detectan solas las columnas de fecha, numéricas y de categoría; nada se guarda al recargar."
          />
        </Panel>
      ) : null}

      {/* Una sola fila de filtros arriba de todo: cada gráfica, la tabla y los
          KPIs se recalculan contra la misma selección, así que los números
          siempre concuerdan entre sí. */}
      {dataset || nombresHojas.length > 1 ? (
        <div className="flex flex-wrap items-end gap-3">
          {nombresHojas.length > 1 ? (
            <Selector etiqueta="Hoja" valor={hojaActual} onCambio={alCambiarHoja}>
              {nombresHojas.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Selector>
          ) : null}

          {dataset && opcionesDimension.length > 0 ? (
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
          ) : null}

          {dataset ? (
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
          ) : null}

          {dataset && colMetrica ? (
            <Selector
              etiqueta="Agregación"
              valor={agregacion}
              onCambio={(v) => setAgregacion(v as Agregacion)}
            >
              <option value="suma">Suma</option>
              <option value="promedio">Promedio</option>
              <option value="conteo">Conteo</option>
            </Selector>
          ) : null}

          {dataset && colFecha ? (
            <Selector
              etiqueta="Granularidad"
              valor={granManual ?? granEfectiva}
              onCambio={(v) => setGranManual(v as Granularidad)}
            >
              <option value="dia">Día</option>
              <option value="mes">Mes</option>
              <option value="anio">Año</option>
            </Selector>
          ) : null}
        </div>
      ) : null}

      {dataset && kpis ? (
        <>
          <AnalisisKpis
            kpis={kpis}
            nombreMetrica={nombreMetrica}
            nombreDimension={colDimension?.nombre ?? null}
          />

          <AnalisisTable
            columnas={dataset.columnas}
            filasVisibles={filasVisibles}
            totalFilas={dataset.totalFilas}
            hoja={dataset.hoja}
            filaEncabezado={dataset.filaEncabezado}
          />

          <AnalisisCharts
            datosBarra={datosBarra}
            datosSerie={datosSerie}
            datosComposicion={datosComposicion}
            nombreDimension={colDimension?.nombre ?? null}
            nombreMetrica={nombreMetrica}
            agregacion={agregacionEfectiva}
            granularidad={granEfectiva}
          />
        </>
      ) : null}
    </div>
  );
}

function Selector({
  etiqueta,
  valor,
  onCambio,
  children,
}: {
  etiqueta: string;
  valor: string;
  onCambio: (valor: string) => void;
  children: React.ReactNode;
}) {
  return (
    <label className="cr-field">
      <span className="cr-label">{etiqueta}</span>
      <select
        className="cr-input w-auto"
        value={valor}
        onChange={(e) => onCambio(e.target.value)}
      >
        {children}
      </select>
    </label>
  );
}

function EsqueletoGraficas() {
  return (
    <div className="flex flex-col gap-6" aria-hidden="true">
      <div className="cr-panel cr-pulse" style={{ height: 420 }} />
      <div className="cr-panel cr-pulse" style={{ height: 320 }} />
    </div>
  );
}
