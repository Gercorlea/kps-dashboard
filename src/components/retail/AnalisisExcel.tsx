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
  acumuladoresDeGrupos,
  agrupar,
  calcularKpis,
  granularidadAuto,
  plegarTopN,
  reagruparSerie,
  rellenarSerie,
  serieTemporal,
  type GrupoAcumulado,
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
  opcionesDeFiltro,
  permutarFilas,
  plantillaPorId,
  seleccionDePlantilla,
  type ColumnaResuelta,
  type Plantilla,
  type SeleccionInicial,
} from "@/lib/retail/analisis/plantillas";
import { formatearEntero } from "@/lib/retail/analisis/formato";
import { METRICA_CONTEO } from "@/lib/retail/analisis/tipos";
import { nombreRetailer, RETAILERS } from "@/lib/retail/retailers";
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
  /** Retailer con el que se guardó; null mientras no se haya guardado. */
  retailer: string | null;
  importadoEl: string | null;
  truncado: boolean;
}

interface ResultadoGuardado {
  insertadas: number;
  actualizadas: number;
  descartadas: number;
  /** Se recuerda con el resultado: el selector puede cambiar después. */
  retailer: string;
}

/** Lo que devuelven tanto `seleccionDePlantilla` como `datasetDesdeHistorico`. */
type DatasetResuelto = {
  plantilla: Plantilla;
  columnas: ColumnaResuelta[];
} & SeleccionInicial;

interface ArchivoHistorico {
  sourceFile: string;
  template: string;
  account: string;
  importedAt: string | null;
  total: number;
}

interface SerieAcumulada {
  granularidad: Granularidad;
  grupos: GrupoAcumulado[];
}

/**
 * Respuesta de GET /api/retail/analisis/resumen: ACUMULADORES, no resultados.
 *
 * Trae la suma de todas las métricas para todas las dimensiones, así que elegir
 * otra métrica o dimensión se resuelve aquí mismo con `acumuladoresDeGrupos` y
 * `plegarTopN` — sin pedirle nada al servidor. Es lo que hace que cambiar un
 * filtro sea tan inmediato como con un archivo en memoria: agregar por cada
 * selección costaba un viaje y se veía el KPI cambiar de etiqueta antes que de
 * valor.
 */
interface RespuestaResumen {
  archivo: ArchivoHistorico | null;
  cuentas: string[];
  /** Selección inicial de la plantilla; null si no hay reporte. */
  seleccion: { dimension: string | null; metrica: string | null; fecha: string | null } | null;
  /** Orden al que están alineados los `suma[]` y `n[]` de cada grupo. */
  metricas?: string[];
  /** La automática, calculada sobre el rango completo del reporte. */
  granularidad?: Granularidad;
  dimensiones?: Record<string, GrupoAcumulado[]>;
  serie?: SerieAcumulada;
  totales?: GrupoAcumulado;
  rangoFechas?: { desde: string; hasta: string } | null;
}

/** Respuesta de GET /api/retail/analisis/filas: una página de la tabla. */
interface RespuestaFilas {
  archivo: ArchivoHistorico | null;
  campos: string[];
  filas: CeldaCruda[][];
  total: number;
  pagina: number;
  paginas: number;
}

/** "2024-07-06" → Date en hora LOCAL, que es como la leen los formateadores. */
function fechaLocal(iso: string): Date {
  const [a, m, d] = iso.split("-").map(Number);
  return new Date(a, m - 1, d);
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

  // Retailer al que pertenece el archivo que se va a guardar. Arranca vacío a
  // propósito: es una decisión de quien sube el reporte, no algo que se pueda
  // deducir de la plantilla, y guardarlo en la cuenta equivocada ensucia el
  // histórico de otro retailer. Sin elegirlo, el botón de guardar no se activa.
  const [retailerGuardar, setRetailerGuardar] = useState("");

  // Qué retailer se está viendo en el histórico. Vacío = el último reporte
  // guardado, sea de quien sea.
  const [retailerVista, setRetailerVista] = useState("");
  const [cuentasConDatos, setCuentasConDatos] = useState<string[]>([]);

  // Acumuladores y página que llegan del servidor cuando el origen es
  // histórico. Con un archivo recién subido quedan en null y mandan los memos.
  const [resumen, setResumen] = useState<RespuestaResumen | null>(null);
  const [paginaHistorico, setPaginaHistorico] = useState<RespuestaFilas | null>(null);
  // Serie diaria: fuera del bundle por tamaño, se pide una sola vez. Lleva de
  // qué archivo es para no mostrar la de un reporte al mirar otro.
  const [serieDiaria, setSerieDiaria] = useState<(SerieAcumulada & { archivo: string }) | null>(
    null
  );
  // Qué se le pidió ya al servidor, para no repetir peticiones en vuelo.
  const claveSerieServida = useRef<string | null>(null);
  const claveFilasServida = useRef<string | null>(null);

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

  // Al entrar se piden los agregados y la PRIMERA PÁGINA del último reporte
  // guardado, no el reporte entero.
  //
  // Antes se bajaba completo para armar con él un Dataset idéntico al de un
  // archivo subido y no tener un "modo histórico". Se midió y esa reutilización
  // costaba 48 s: 15,344 filas son 5.2 MB y el enlace a la base sostiene
  // ~110 KB/s. Ahora Mongo agrega y pagina, y lo que se comparte entre los dos
  // modos son los helpers de agregar.ts, no el transporte de las filas.
  //
  // La página sigue armando un Dataset real: `columnasHistorico` saca tipos y
  // roles de la PLANTILLA y no de los datos, así que 100 filas describen las
  // columnas igual que 15,344. Por eso la tabla, el formateo de celdas y el
  // buscador siguen siendo el mismo código.
  const cargarHistorico = useCallback(async () => {
    try {
      const q = retailerVista ? `?account=${encodeURIComponent(retailerVista)}` : "";
      const [res, pag] = await Promise.all([
        api<RespuestaResumen>(`/api/retail/analisis/resumen${q}`),
        api<RespuestaFilas>(
          `/api/retail/analisis/filas${q}${q ? "&" : "?"}page=1&limit=${FILAS_POR_PAGINA}`
        ),
      ]);
      setCuentasConDatos(res.cuentas);
      const plantilla = res.archivo ? plantillaPorId(res.archivo.template) : null;
      if (!res.archivo || !plantilla || pag.filas.length === 0) {
        setEstado("inactivo");
        return;
      }
      const resuelto = datasetDesdeHistorico(
        plantilla,
        pag.campos,
        pag.filas,
        res.archivo.sourceFile
      );
      setResumen(res);
      setPaginaHistorico(pag);
      // Otro reporte es otra serie diaria: la anterior deja de aplicar.
      setSerieDiaria(null);
      claveSerieServida.current = null;
      claveFilasServida.current = JSON.stringify({
        archivo: res.archivo.sourceFile,
        buscar: "",
        pagina: 1,
      });
      setProcedencia({
        origen: "historico",
        archivo: res.archivo.sourceFile,
        retailer: res.archivo.account,
        importadoEl: fechaHora(res.archivo.importedAt),
        // Ya no se recorta nada: la tabla pagina y las gráficas vienen
        // agregadas sobre el reporte completo.
        truncado: false,
      });
      aplicarDataset(resuelto.dataset, resuelto);
    } catch {
      // Que el histórico no cargue no rompe la pestaña: se puede seguir
      // subiendo un archivo, así que se cae al estado vacío en vez de a un
      // error que bloquee la vista.
      setEstado("inactivo");
    }
    // retailerVista es dependencia real: cambiar de retailer recarga el último
    // reporte de ESE retailer.
  }, [aplicarDataset, retailerVista]);

  useEffect(() => {
    // fetch-on-mount: el estado inicial ya es "cargando"
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void cargarHistorico();
  }, [cargarHistorico]);

  // Manda el dataset al histórico por lotes: 15 mil filas en un solo POST son
  // varios MB sin señal de avance, y el upsert por lote deja el progreso
  // visible. Es idempotente, así que reintentar no duplica.
  const guardarEnHistorico = useCallback(async () => {
    // El retailer es obligatorio; el botón ya viene deshabilitado sin él, esto
    // es el cinturón por si se dispara desde otro lado.
    if (!dataset || !plantilla || !columnasResueltas || !retailerGuardar) return;
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
              template: plantilla.id,
              account: retailerGuardar,
              sourceFile: nombreArchivo ?? dataset.hoja,
              filas: lote,
            }),
          }
        );
        insertadas += r.insertadas;
        actualizadas += r.actualizadas;
        setProgreso(Math.min(1, (i + lote.length) / filas.length));
      }

      setGuardado({ insertadas, actualizadas, descartadas, retailer: retailerGuardar });
    } catch (error) {
      setMensajeError(
        error instanceof ClientApiError
          ? `No se pudo guardar en el histórico: ${error.message}`
          : "No se pudo guardar en el histórico."
      );
    } finally {
      setGuardando(false);
    }
  }, [dataset, plantilla, columnasResueltas, nombreArchivo, retailerGuardar]);

  const alArchivo = useCallback(
    async (file: File) => {
      setEstado("leyendo");
      setMensajeError(null);
      setNombreArchivo(file.name);
      setProcedencia({
        origen: "archivo",
        archivo: file.name,
        retailer: null,
        importadoEl: null,
        truncado: false,
      });
      // Un archivo se analiza entero en el navegador: lo que había llegado del
      // servidor para el histórico deja de aplicar.
      setResumen(null);
      setPaginaHistorico(null);
      setSerieDiaria(null);
      claveSerieServida.current = null;
      claveFilasServida.current = null;
      // Otro archivo puede ser de otro retailer: se vuelve a preguntar en vez
      // de arrastrar la elección del anterior.
      setRetailerGuardar("");
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

  // Con plantilla reconocida el catálogo de filtros lo declara ella; un archivo
  // cualquiera sigue cayendo a la inferencia, que es lo único que tiene.
  const opcionesDimension = columnasResueltas
    ? opcionesDeFiltro(columnasResueltas, "dimension")
    : dataset
      ? columnasDimension(dataset.columnas)
      : [];
  const opcionesMetrica = columnasResueltas
    ? opcionesDeFiltro(columnasResueltas, "metrica")
    : dataset
      ? columnasMetrica(dataset.columnas)
      : [];

  // "Cantidad de filas" es la métrica de rescate para un archivo sin columnas
  // numéricas. Con plantilla hay métricas declaradas, así que sólo estorbaría.
  const ofrecerConteo = opcionesMetrica.length === 0 || !columnasResueltas;

  // Elegir una métrica real saca de "Conteo", que ya no está en el desplegable:
  // sin esto la agregación quedaría en un valor sin opción que lo represente.
  const alCambiarMetrica = useCallback(
    (valor: string) => {
      const i = Number(valor);
      setIdxMetrica(i);
      if (i !== METRICA_CONTEO) setAgregacion((a) => (a === "conteo" ? "suma" : a));
    },
    []
  );

  // ---------------------------------------------- los dos orígenes, un render
  //
  // Un archivo subido tiene todas sus filas en memoria y agrega arriba, en los
  // memos. El histórico las tiene en Mongo y agrega allá, porque traerlas costó
  // 48 s medidos. De esta costura para abajo el render no distingue: recibe las
  // mismas formas (`PuntoAgrupado`, `PuntoSerie`, `Kpis`) en los dos casos.

  const esHistorico = procedencia?.origen === "historico";
  const archivoHistorico = esHistorico ? (procedencia?.archivo ?? null) : null;

  // Los selectores siguen hablando de índices de columna; el servidor habla de
  // campos de la plantilla. Aquí se traduce.
  const campoDimension =
    columnasResueltas && idxDimension >= 0
      ? (columnasResueltas[idxDimension]?.campo ?? null)
      : null;
  const campoMetrica =
    columnasResueltas && idxMetrica >= 0
      ? (columnasResueltas[idxMetrica]?.campo ?? null)
      : null;

  // Cambiar dimensión, métrica o agregación NO pide nada: el bundle ya trae los
  // acumuladores de todas las combinaciones y el plegado ocurre más abajo.
  //
  // La única excepción es la granularidad diaria: son 735 buckets contra los 25
  // de la mensual, 205 KB contra 50, así que se queda fuera del bundle y se pide
  // la primera vez que se elige. Después vive en el estado y ya no se repite.
  const granVista: Granularidad = esHistorico
    ? (granManual ?? resumen?.granularidad ?? "mes")
    : granEfectiva;

  useEffect(() => {
    if (!esHistorico || !archivoHistorico || granVista !== "dia") return;
    if (serieDiaria?.archivo === archivoHistorico) return;
    const clave = `dia:${archivoHistorico}`;
    if (claveSerieServida.current === clave) return;
    claveSerieServida.current = clave;

    const q = new URLSearchParams({
      sourceFile: archivoHistorico,
      parte: "serie",
      granularidad: "dia",
    });
    if (retailerVista) q.set("account", retailerVista);
    void api<{ serie: SerieAcumulada }>(`/api/retail/analisis/resumen?${q.toString()}`)
      .then((r) => setSerieDiaria({ archivo: archivoHistorico, ...r.serie }))
      // Si falla, la gráfica temporal queda vacía pero el resto de la pestaña
      // sigue en pie; volver a elegir "Día" reintenta.
      .catch(() => {
        claveSerieServida.current = null;
      });
  }, [esHistorico, archivoHistorico, granVista, retailerVista, serieDiaria]);

  // Buscar y paginar el histórico también son del servidor: filtrar en el
  // navegador sólo alcanzaría a la página que está en pantalla.
  useEffect(() => {
    if (!esHistorico || !archivoHistorico) return;
    const clave = JSON.stringify({
      archivo: archivoHistorico,
      buscar: busquedaDiferida,
      pagina,
    });
    if (claveFilasServida.current === clave) return;
    claveFilasServida.current = clave;

    const q = new URLSearchParams({
      sourceFile: archivoHistorico,
      page: String(pagina),
      limit: String(FILAS_POR_PAGINA),
    });
    if (retailerVista) q.set("account", retailerVista);
    if (busquedaDiferida) q.set("buscar", busquedaDiferida);
    void api<RespuestaFilas>(`/api/retail/analisis/filas?${q.toString()}`)
      .then(setPaginaHistorico)
      .catch(() => {});
  }, [esHistorico, archivoHistorico, busquedaDiferida, pagina, retailerVista]);

  // La página del histórico llega en el orden de `campos`; se permuta al de las
  // columnas con el mismo helper que arma el dataset inicial.
  const filasHistorico = useMemo(
    () =>
      paginaHistorico && columnasResueltas
        ? permutarFilas(columnasResueltas, paginaHistorico.campos, paginaHistorico.filas)
        : [],
    [paginaHistorico, columnasResueltas]
  );

  // Acumuladores de la dimensión y la métrica elegidas. Cambiar cualquiera de
  // las dos sólo recalcula este Map sobre ~38 grupos: es la misma operación que
  // hace `agrupar` con las filas en memoria, pero partiendo de lo que ya sumó
  // Mongo. De aquí sale todo lo demás sin tocar la red.
  const acumHistorico = useMemo(() => {
    const grupos = campoDimension ? resumen?.dimensiones?.[campoDimension] : null;
    return grupos ? acumuladoresDeGrupos(grupos, resumen?.metricas ?? [], campoMetrica) : null;
  }, [resumen, campoDimension, campoMetrica]);

  const barraVista = useMemo(
    () =>
      esHistorico
        ? acumHistorico
          ? plegarTopN(acumHistorico, agregacionEfectiva, TOP_BARRA)
          : []
        : datosBarra,
    [esHistorico, acumHistorico, agregacionEfectiva, datosBarra]
  );

  // La participación se calcula SIEMPRE sobre la suma (o el conteo), igual que
  // en el camino del archivo: un promedio no es aditivo.
  const composicionVista = useMemo(
    () =>
      esHistorico
        ? acumHistorico
          ? plegarTopN(acumHistorico, campoMetrica ? "suma" : "conteo", TOP_COMPOSICION)
          : []
        : datosComposicion,
    [esHistorico, acumHistorico, campoMetrica, datosComposicion]
  );

  const serieVista = useMemo(() => {
    if (!esHistorico) return datosSerie;
    if (!resumen?.serie) return null;
    // Mes y año salen de la serie mensual del bundle; el año recortando la
    // clave. Sólo el día necesita la serie diaria, que puede no haber llegado.
    if (granVista === "dia") {
      if (serieDiaria?.archivo !== archivoHistorico) return null;
      return rellenarSerie(
        acumuladoresDeGrupos(serieDiaria.grupos, resumen.metricas ?? [], campoMetrica),
        agregacionEfectiva,
        "dia"
      );
    }
    const mensual = acumuladoresDeGrupos(
      resumen.serie.grupos,
      resumen.metricas ?? [],
      campoMetrica
    );
    return rellenarSerie(
      granVista === "anio" ? reagruparSerie(mensual, 4) : mensual,
      agregacionEfectiva,
      granVista
    );
  }, [
    esHistorico,
    datosSerie,
    resumen,
    serieDiaria,
    archivoHistorico,
    granVista,
    campoMetrica,
    agregacionEfectiva,
  ]);

  const kpisVista = useMemo(() => {
    if (!esHistorico) return kpis;
    if (!resumen?.totales) return null;
    const i = campoMetrica ? (resumen.metricas ?? []).indexOf(campoMetrica) : -1;
    return {
      // Sin métrica el "total" son las filas, igual que `calcularKpis`, que con
      // `colMetrica` nulo hace `total++` en vez de sumar una columna.
      totalMetrica: i < 0 ? resumen.totales.conteo : (resumen.totales.suma[i] ?? 0),
      totalFilas: resumen.totales.conteo,
      // El servidor ya fusionó las claves que se normalizan a lo mismo, así que
      // la cantidad de grupos ES la cantidad de valores distintos.
      dimensionesDistintas: acumHistorico?.size ?? 0,
      rangoFechas: resumen.rangoFechas
        ? {
            desde: fechaLocal(resumen.rangoFechas.desde),
            hasta: fechaLocal(resumen.rangoFechas.hasta),
          }
        : null,
    };
  }, [esHistorico, kpis, resumen, campoMetrica, acumHistorico]);

  const filasVista = esHistorico ? filasHistorico : filasVisibles;
  const totalFilasVista = esHistorico
    ? (resumen?.archivo?.total ?? 0)
    : (dataset?.totalFilas ?? 0);
  const totalFiltradasVista = esHistorico
    ? (paginaHistorico?.total ?? 0)
    : filasFiltradas.length;
  const paginasVista = esHistorico ? (paginaHistorico?.paginas ?? 1) : paginas;
  const paginaVista = esHistorico
    ? Math.min(Math.max(1, pagina), paginasVista)
    : paginaActual;

  // Procedencia de las filas. Un archivo cuenta de qué hoja salió y dónde se
  // detectó el encabezado — un acierto dudoso tiene que ser visible en pantalla
  // en vez de silencioso. El histórico no tuvo detección que exponer: dice de
  // qué archivo viene y cuándo se importó.
  const detallesTabla = useMemo(() => {
    if (!dataset) return [];
    if (procedencia?.origen === "historico") {
      return [
        ...(procedencia.retailer ? [nombreRetailer(procedencia.retailer)] : []),
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
          {/* Sólo al ver el histórico: elige de QUÉ retailer se mira el último
              reporte. Con un archivo cargado no aplica — se está viendo ese
              archivo, y el retailer se elige al guardarlo. */}
          {procedencia?.origen === "historico" && cuentasConDatos.length > 1 ? (
            <Selector
              etiqueta="Retailer"
              valor={retailerVista}
              onCambio={setRetailerVista}
            >
              <option value="">Último guardado</option>
              {cuentasConDatos.map((id) => (
                <option key={id} value={id}>
                  {nombreRetailer(id)}
                </option>
              ))}
            </Selector>
          ) : null}

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
            <Selector etiqueta="Métrica" valor={String(idxMetrica)} onCambio={alCambiarMetrica}>
              {ofrecerConteo ? <option value={METRICA_CONTEO}>Cantidad de filas</option> : null}
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
              {/* Sin "Conteo": contaba FILAS del reporte, no unidades ni
                  ventas, y con una fila por artículo y día lo que devolvía era
                  "en cuántos días apareció", que se lee como un dato de venta y
                  no lo es. Quien quiera filas tiene la métrica "Cantidad de
                  filas" cuando el archivo no trae plantilla. */}
              <option value="suma">Suma</option>
              <option value="promedio">Promedio</option>
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
            <div className="flex flex-wrap items-end gap-3">
              {/* Obligatorio y sin valor por omisión: es lo que separa los
                  reportes por retailer, y un default silencioso terminaría
                  metiendo el reporte de uno en el histórico de otro. */}
              <Selector
                etiqueta="Retailer del reporte"
                valor={retailerGuardar}
                onCambio={setRetailerGuardar}
              >
                <option value="">Selecciona…</option>
                {RETAILERS.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.nombre}
                  </option>
                ))}
              </Selector>

              <button
                type="button"
                className="cr-btn cr-btn--primary"
                disabled={guardando || !retailerGuardar}
                aria-busy={guardando}
                title={
                  retailerGuardar ? undefined : "Elige primero el retailer del reporte"
                }
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
          </div>

          {guardando ? (
            <div className="mt-3">
              <Meter value={progreso} tono="ink" />
            </div>
          ) : null}

          {guardado ? (
            <p className="cr-small mt-3" style={{ color: "var(--cr-ok)" }} role="status">
              Listo en {nombreRetailer(guardado.retailer)}:{" "}
              {formatearEntero(guardado.insertadas)} filas nuevas y{" "}
              {formatearEntero(guardado.actualizadas)} actualizadas
              {guardado.descartadas > 0
                ? ` · ${formatearEntero(guardado.descartadas)} descartadas por no tener fecha o código de artículo`
                : ""}
              .
            </p>
          ) : null}
        </Panel>
      ) : null}

      {dataset && kpisVista ? (
        <>
          <AnalisisKpis
            kpis={kpisVista}
            nombreMetrica={nombreMetrica}
            nombreDimension={colDimension?.nombre ?? null}
          />

          <AnalisisTable
            // Volcado crudo del Excel: 14 columnas que sólo entran apretadas.
            densa
            titulo={esHistorico ? "Último reporte guardado" : "Datos"}
            columnas={columnasTabla}
            filasVisibles={filasVista}
            totalFilas={totalFilasVista}
            totalFiltradas={totalFiltradasVista}
            totalColumnas={dataset.columnas.length}
            detalles={detallesTabla}
            busqueda={busqueda}
            // En memoria el filtro corre con el valor diferido, así que ése es
            // el que describe las filas en pantalla. En histórico es además el
            // que se le mandó al servidor.
            busquedaAplicada={busquedaDiferida}
            onBusqueda={alBuscar}
            columnasBuscadas={columnasBuscadas.map((c) => c.nombre)}
            pagina={paginaVista}
            paginas={paginasVista}
            porPagina={FILAS_POR_PAGINA}
            onPagina={setPagina}
          />

          <AnalisisCharts
            datosBarra={barraVista}
            datosSerie={serieVista}
            datosComposicion={composicionVista}
            nombreDimension={colDimension?.nombre ?? null}
            nombreMetrica={nombreMetrica}
            agregacion={agregacionEfectiva}
            granularidad={granVista}
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
