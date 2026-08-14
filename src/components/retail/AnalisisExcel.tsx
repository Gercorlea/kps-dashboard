"use client";

// Único punto de entrada de cliente del analizador: aquí vive todo el estado y
// todas las agregaciones memoizadas. Los componentes que renderiza no necesitan
// su propia directiva "use client" — entran al bundle de cliente por ser
// importados desde aquí.

import { Database } from "lucide-react";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnalisisKpis } from "@/components/retail/AnalisisKpis";
import { AnalisisTable } from "@/components/retail/AnalisisTable";
import { AnalisisUploader } from "@/components/retail/AnalisisUploader";
import { api, ClientApiError } from "@/components/lib/api-client";
import { useDiferido } from "@/components/lib/useDiferido";
import { Badge, EstadoVacio, Meter, Panel } from "@/components/ui/basicos";
import {
  agrupar,
  calcularKpis,
  granularidadAuto,
  serieTemporal,
} from "@/lib/retail/analisis/agregar";
import { filtrarFilas, paginar, totalPaginas } from "@/lib/retail/analisis/filtrar";
import {
  columnasBuscables,
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
import {
  datasetDesdeHistorico,
  filasParaHistorico,
  plantillaPorId,
  seleccionDePlantilla,
  type ColumnaResuelta,
  type Plantilla,
  type SeleccionInicial,
} from "@/lib/retail/analisis/plantillas";
import { formatearEntero } from "@/lib/retail/analisis/formato";
import { METRICA_CONTEO } from "@/lib/retail/analisis/tipos";
import { MAX_FILAS_LOTE } from "@/lib/validation/retail";
import type {
  Agregacion,
  CeldaCruda,
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

const FILAS_POR_PAGINA = 100;
const TOP_BARRA = 8;
const TOP_COMPOSICION = 5;

type Estado = "cargando" | "inactivo" | "leyendo" | "listo" | "error";

/**
 * De dónde salieron las filas que se están analizando.
 *
 * Sólo cambia el envoltorio — el título de la tabla, su leyenda de procedencia
 * y si tiene sentido ofrecer "Guardar en histórico". Los filtros, los KPIs, la
 * tabla y las gráficas corren igual en los dos casos, porque los dos producen
 * el mismo `Dataset`.
 */
type Origen = "archivo" | "historico";

interface Procedencia {
  origen: Origen;
  /** Nombre del .xlsx del que salieron las filas. */
  archivo: string;
  importadoEl: string | null;
  truncado: boolean;
}

interface ResultadoGuardado {
  insertadas: number;
  actualizadas: number;
  descartadas: number;
}

/** Lo que devuelven tanto `seleccionDePlantilla` como `datasetDesdeHistorico`. */
type DatasetResuelto = {
  plantilla: Plantilla;
  columnas: ColumnaResuelta[];
} & SeleccionInicial;

/** Respuesta de GET /api/retail/analisis/dataset. */
interface RespuestaHistorico {
  archivo: {
    sourceFile: string;
    template: string;
    account: string;
    importedAt: string | null;
    total: number;
  } | null;
  campos: string[];
  filas: CeldaCruda[][];
  truncado: boolean;
}

function fechaHora(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? null
    : d.toLocaleString("es-MX", { dateStyle: "medium", timeStyle: "short" });
}

export function AnalisisExcel() {
  // Arranca cargando: al entrar se busca el último reporte guardado antes de
  // decidir si la pestaña está vacía.
  const [estado, setEstado] = useState<Estado>("cargando");
  const [procedencia, setProcedencia] = useState<Procedencia | null>(null);
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

  // Buscador y paginado de la tabla. Aquí las filas ya están en memoria, así
  // que filtrar y paginar es un slice; el histórico hace lo mismo contra Mongo.
  const [busqueda, setBusqueda] = useState("");
  const busquedaDiferida = useDiferido(busqueda);
  const [pagina, setPagina] = useState(1);

  // Buscar reinicia el paginado: el resultado se encoge y la página en la que
  // estabas puede dejar de existir.
  const alBuscar = useCallback((valor: string) => {
    setBusqueda(valor);
    setPagina(1);
  }, []);

  // Plantilla reconocida (si la hay) y estado de la escritura al histórico.
  const [plantilla, setPlantilla] = useState<Plantilla | null>(null);
  const [columnasResueltas, setColumnasResueltas] = useState<ColumnaResuelta[] | null>(null);
  const [guardando, setGuardando] = useState(false);
  const [progreso, setProgreso] = useState(0);
  const [guardado, setGuardado] = useState<ResultadoGuardado | null>(null);

  const aplicarDataset = useCallback((ds: Dataset, yaResuelto?: DatasetResuelto) => {
    setGuardado(null);
    setHojaActual(ds.hoja);
    setGranManual(null);
    setMensajeError(null);
    setEstado("listo");
    // Otro archivo (u otra hoja) es otro conjunto de filas: conservar la
    // búsqueda o la página anterior mostraría una tabla vacía sin explicación.
    setBusqueda("");
    setPagina(1);

    // El histórico llega con los roles ya resueltos desde la plantilla; un
    // archivo hay que reconocerlo primero. Si el layout coincide con una
    // plantilla conocida los roles vienen declarados y no hay que adivinar cuál
    // de seis columnas numéricas es la métrica. Si no coincide, se cae a la
    // inferencia genérica.
    const porPlantilla = yaResuelto ?? seleccionDePlantilla(ds);
    if (porPlantilla) {
      const conRoles = { ...ds, columnas: porPlantilla.columnas };
      setDataset(conRoles);
      setPlantilla(porPlantilla.plantilla);
      setColumnasResueltas(porPlantilla.columnas);
      setIdxDimension(porPlantilla.idxDimension);
      setIdxMetrica(porPlantilla.idxMetrica);
      setIdxFecha(porPlantilla.idxFecha);
      setAgregacion(porPlantilla.idxMetrica === METRICA_CONTEO ? "conteo" : "suma");
      return;
    }

    setDataset(ds);
    setPlantilla(null);
    setColumnasResueltas(null);
    setIdxDimension(elegirDimension(ds.columnas));
    const met = elegirMetrica(ds.columnas);
    setIdxMetrica(met);
    setIdxFecha(elegirFecha(ds.columnas));
    setAgregacion(met === METRICA_CONTEO ? "conteo" : "suma");
  }, []);

  // Al entrar se baja el último reporte guardado y se arma con él un Dataset
  // idéntico al de un archivo recién subido. Por eso los filtros, los KPIs, la
  // tabla y las gráficas funcionan sin una segunda implementación: no hay un
  // "modo histórico", hay las mismas filas viniendo de otro lado.
  const cargarHistorico = useCallback(async () => {
    try {
      const r = await api<RespuestaHistorico>("/api/retail/analisis/dataset");
      const plantilla = r.archivo ? plantillaPorId(r.archivo.template) : null;
      if (!r.archivo || !plantilla || r.filas.length === 0) {
        setEstado("inactivo");
        return;
      }
      const resuelto = datasetDesdeHistorico(
        plantilla,
        r.campos,
        r.filas,
        r.archivo.sourceFile
      );
      setProcedencia({
        origen: "historico",
        archivo: r.archivo.sourceFile,
        importadoEl: fechaHora(r.archivo.importedAt),
        truncado: r.truncado,
      });
      aplicarDataset(resuelto.dataset, resuelto);
    } catch {
      // Que el histórico no cargue no rompe la pestaña: se puede seguir
      // subiendo un archivo, así que se cae al estado vacío en vez de a un
      // error que bloquee la vista.
      setEstado("inactivo");
    }
  }, [aplicarDataset]);

  useEffect(() => {
    // fetch-on-mount: el estado inicial ya es "cargando"
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void cargarHistorico();
  }, [cargarHistorico]);

  // Manda el dataset al histórico por lotes: 15 mil filas en un solo POST son
  // varios MB sin señal de avance, y el upsert por lote deja el progreso
  // visible. Es idempotente, así que reintentar no duplica.
  const guardarEnHistorico = useCallback(async () => {
    if (!dataset || !plantilla || !columnasResueltas) return;
    setGuardando(true);
    setProgreso(0);
    setGuardado(null);
    setMensajeError(null);

    try {
      const { filas, descartadas } = filasParaHistorico(dataset, columnasResueltas);
      let insertadas = 0;
      let actualizadas = 0;

      for (let i = 0; i < filas.length; i += MAX_FILAS_LOTE) {
        const lote = filas.slice(i, i + MAX_FILAS_LOTE);
        const r = await api<{ insertadas: number; actualizadas: number }>(
          "/api/retail/analisis",
          {
            method: "POST",
            body: JSON.stringify({
              plantilla: plantilla.id,
              account: plantilla.account,
              sourceFile: nombreArchivo ?? dataset.hoja,
              filas: lote,
            }),
          }
        );
        insertadas += r.insertadas;
        actualizadas += r.actualizadas;
        setProgreso(Math.min(1, (i + lote.length) / filas.length));
      }

      setGuardado({ insertadas, actualizadas, descartadas });
    } catch (error) {
      setMensajeError(
        error instanceof ClientApiError
          ? `No se pudo guardar en el histórico: ${error.message}`
          : "No se pudo guardar en el histórico."
      );
    } finally {
      setGuardando(false);
    }
  }, [dataset, plantilla, columnasResueltas, nombreArchivo]);

  const alArchivo = useCallback(
    async (file: File) => {
      setEstado("leyendo");
      setMensajeError(null);
      setNombreArchivo(file.name);
      setProcedencia({
        origen: "archivo",
        archivo: file.name,
        importadoEl: null,
        truncado: false,
      });
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

  // La tabla muestra las mismas columnas que ofrecen los filtros: fuera las
  // vacías y las constantes. Con la plantilla de Walmart eso quita cuatro
  // columnas — entre ellas "Vendor Name", la más ancha del reporte — y es lo
  // que hace que las 14 restantes entren en pantalla sin scroll horizontal.
  const columnasTabla = useMemo(
    () => dataset?.columnas.filter((c) => c.tipo !== "vacia" && !c.esConstante) ?? [],
    [dataset]
  );

  const columnasBuscadas = useMemo(() => columnasBuscables(columnasTabla), [columnasTabla]);

  // El buscador afecta SÓLO a la tabla: los KPIs y las gráficas siguen
  // hablando del reporte completo. Filtrarlos también dejaría un "Total POS
  // Sales" que cambia mientras se escribe, sin que la pantalla diga por qué.
  const filasFiltradas = useMemo(
    () => (dataset ? filtrarFilas(dataset.filas, columnasBuscadas, busquedaDiferida) : []),
    [dataset, columnasBuscadas, busquedaDiferida]
  );

  const paginas = totalPaginas(filasFiltradas.length, FILAS_POR_PAGINA);
  // Red de seguridad por si el dataset cambia bajo una página alta; el reset
  // real ocurre en alBuscar, antes de que la búsqueda encoja el resultado.
  const paginaActual = Math.min(Math.max(1, pagina), paginas);

  const filasVisibles = useMemo(
    () => paginar(filasFiltradas, paginaActual, FILAS_POR_PAGINA),
    [filasFiltradas, paginaActual]
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

  // Procedencia de las filas. Un archivo cuenta de qué hoja salió y dónde se
  // detectó el encabezado — un acierto dudoso tiene que ser visible en pantalla
  // en vez de silencioso. El histórico no tuvo detección que exponer: dice de
  // qué archivo viene y cuándo se importó.
  const detallesTabla = useMemo(() => {
    if (!dataset) return [];
    if (procedencia?.origen === "historico") {
      return [
        `archivo «${procedencia.archivo}»`,
        ...(procedencia.importadoEl ? [`importado el ${procedencia.importadoEl}`] : []),
        ...(procedencia.truncado
          ? ["recortado: sube el archivo para analizarlo completo"]
          : []),
      ];
    }
    return [
      `hoja «${dataset.hoja}»`,
      dataset.filaEncabezado >= 0
        ? `encabezado en la fila ${dataset.filaEncabezado + 1}`
        : "sin encabezado detectado",
    ];
  }, [dataset, procedencia]);

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

      {estado === "cargando" ? (
        <div className="flex flex-col gap-6" aria-busy="true">
          <div className="cr-panel cr-pulse" style={{ height: 96 }} />
          <div className="cr-panel cr-pulse" style={{ height: 280 }} />
        </div>
      ) : null}

      {estado === "inactivo" && !mensajeError ? (
        <Panel>
          <EstadoVacio
            title="Sin archivo cargado"
            detalle="Sube un .xlsx para ver los datos y su análisis. Se detectan solas las columnas de fecha, numéricas y de categoría. Al guardarlo en el histórico volverá a aparecer aquí la próxima vez que entres."
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

      {/* La plantilla reconocida es lo que habilita guardar: sin ella no hay
          mapeo fiable de encabezados a campos del histórico. El reporte que
          viene DEL histórico no se ofrece guardar: ya está guardado. */}
      {dataset && plantilla && procedencia?.origen === "archivo" ? (
        <Panel title="Histórico de reportes">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <Badge tono="ok">Plantilla reconocida</Badge>
                <span className="cr-body">{plantilla.nombre}</span>
              </div>
              <span className="cr-small">
                Se guardan {columnasResueltas?.filter((c) => c.rol !== "ignorada").length} columnas;
                se omiten{" "}
                {columnasResueltas
                  ?.filter((c) => c.rol === "ignorada")
                  .map((c) => c.nombre)
                  .join(", ")}{" "}
                por ser constantes o vacías. Volver a guardar el mismo reporte actualiza en vez
                de duplicar.
              </span>
            </div>
            <button
              type="button"
              className="cr-btn cr-btn--primary"
              disabled={guardando}
              aria-busy={guardando}
              onClick={() => void guardarEnHistorico()}
            >
              {guardando ? (
                <>
                  <span className="cr-spin" aria-hidden="true" />
                  Guardando…
                </>
              ) : (
                <>
                  <Database strokeWidth={1.75} />
                  Guardar en histórico
                </>
              )}
            </button>
          </div>

          {guardando ? (
            <div className="mt-3">
              <Meter value={progreso} tono="ink" />
            </div>
          ) : null}

          {guardado ? (
            <p className="cr-small mt-3" style={{ color: "var(--cr-ok)" }} role="status">
              Listo: {formatearEntero(guardado.insertadas)} filas nuevas y{" "}
              {formatearEntero(guardado.actualizadas)} actualizadas
              {guardado.descartadas > 0
                ? ` · ${formatearEntero(guardado.descartadas)} descartadas por no tener fecha o código de artículo`
                : ""}
              .
            </p>
          ) : null}
        </Panel>
      ) : null}

      {dataset && kpis ? (
        <>
          <AnalisisKpis
            kpis={kpis}
            nombreMetrica={nombreMetrica}
            nombreDimension={colDimension?.nombre ?? null}
          />

          <AnalisisTable
            titulo={procedencia?.origen === "historico" ? "Último reporte guardado" : "Datos"}
            columnas={columnasTabla}
            filasVisibles={filasVisibles}
            totalFilas={dataset.totalFilas}
            totalFiltradas={filasFiltradas.length}
            totalColumnas={dataset.columnas.length}
            detalles={detallesTabla}
            busqueda={busqueda}
            // En memoria el filtro corre con el valor diferido, así que ése es
            // el que describe las filas en pantalla.
            busquedaAplicada={busquedaDiferida}
            onBusqueda={alBuscar}
            columnasBuscadas={columnasBuscadas.map((c) => c.nombre)}
            pagina={paginaActual}
            paginas={paginas}
            porPagina={FILAS_POR_PAGINA}
            onPagina={setPagina}
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
