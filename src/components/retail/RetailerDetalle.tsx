"use client";

// Ficha de un retailer: cabecera con estado y métricas, barra de pestañas y un
// panel por sección.
//
// Las cuatro pestañas se sirven del MISMO bundle de acumuladores, así que
// cambiar de sección —y de métrica o dimensión dentro de ella— no vuelve a
// pedir nada. Es el mismo trato que /retail/analisis: Mongo agrega una
// vez y el navegador pliega, porque el enlace a la base es lento.

import Link from "next/link";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FileSpreadsheet } from "lucide-react";
import { api } from "@/components/lib/api-client";
import { fmtFecha, fmtFechaHora, fmtNum, fmtPct } from "@/components/lib/fmt";
import { AnalisisKpis, type EvolucionKpis } from "@/components/retail/AnalisisKpis";
import { AnalisisTable } from "@/components/retail/AnalisisTable";
import { AutorReporte, type UsuarioReporte } from "@/components/retail/AutorReporte";
import { ReporteDetalle } from "@/components/retail/ReporteDetalle";
import {
  RetailerContenidoSkeleton,
  RetailerGraficasSkeleton,
  RetailerTablaSkeleton,
} from "@/components/retail/RetailerSkeleton";
import { SelectorPeriodo } from "@/components/retail/SelectorPeriodo";
import { Badge, EstadoVacio, Meter, Panel } from "@/components/ui/basicos";
import {
  acumuladoresDeGrupos,
  compararAnios,
  granularidadPorRango,
  plegarTopN,
  reagruparSerie,
  rellenarSerie,
  valorMetricaAgregada,
  type Acumulador,
  type GrupoAcumulado,
  type GrupoProducto,
} from "@/lib/retail/analisis/agregar";
import {
  estadoDelPeriodo,
  ventanaDelRango,
  type RangoISO,
} from "@/lib/retail/analisis/periodos";
import { columnasHistorico, plantillaPorId } from "@/lib/retail/analisis/plantillas";
import { colorRetailer } from "@/lib/retail/retailers";
import type { DetalleRetailer } from "@/lib/retail/stats";
import type {
  Agregacion,
  CeldaCruda,
  Granularidad,
  MetaColumna,
  PuntoAgrupado,
} from "@/lib/retail/analisis/tipos";

// Mismo motivo que en el analizador: recharts es lo más pesado de la ruta y no
// sirve de nada hasta que hay datos que dibujar.
//
// El fallback es el mismo esqueleto de las gráficas que se ve mientras cargan
// los datos: si el módulo llega después que ellos, los paneles ya están en su
// sitio y sólo se rellenan.
const AnalisisCharts = dynamic(() => import("@/components/retail/AnalisisCharts"), {
  ssr: false,
  loading: () => (
    <div className="cr-pulse">
      <RetailerGraficasSkeleton />
    </div>
  ),
});

const TOP_BARRA = 8;
const TOP_COMPOSICION = 5;
const PRODUCTOS_POR_PAGINA = 100;

type Vista = "resumen" | "ventas" | "productos" | "reportes";

/** Sentido del orden de la tabla de productos. */
type Direccion = "asc" | "desc";

/** Cómo se dice el sentido según el tipo del campo, para la leyenda. */
function etiquetaSentido(numerico: boolean, direccion: Direccion): string {
  if (numerico) return direccion === "desc" ? "(mayor a menor)" : "(menor a mayor)";
  return direccion === "asc" ? "(A → Z)" : "(Z → A)";
}

const VISTAS: { id: Vista; etiqueta: string }[] = [
  // El id se queda en "resumen": es interno y lo usan el estado y los
  // condicionales de abajo. Lo que se lee en la barra es la etiqueta.
  { id: "resumen", etiqueta: "Overview" },
  { id: "ventas", etiqueta: "Ventas" },
  { id: "productos", etiqueta: "Productos" },
  { id: "reportes", etiqueta: "Reportes" },
];

interface SerieAcumulada {
  granularidad: Granularidad;
  grupos: GrupoAcumulado[];
}

interface Bundle {
  archivo: { sourceFile: string; template: string; importedAt: string | null; total: number } | null;
  seleccion: { dimension: string | null; metrica: string | null; fecha: string | null } | null;
  metricas?: string[];
  granularidad?: Granularidad;
  dimensiones?: Record<string, GrupoAcumulado[]>;
  /** Grano de la pestaña de productos; null si la plantilla no lo declara. */
  producto?: { campos: string[]; grupos: GrupoProducto[] } | null;
  serie?: SerieAcumulada;
  totales?: GrupoAcumulado;
  rangoFechas?: { desde: string; hasta: string } | null;
}

/** Una fila de "Reportes guardados". */
interface Archivo {
  sourceFile: string;
  filas: number;
  /** Primera vez que se guardó el reporte; no cambia al volver a subirlo. */
  importado: string | null;
  /** Null mientras el reporte no se haya vuelto a subir. */
  actualizado: string | null;
  subidoPor: UsuarioReporte | null;
}

/** "2024-07-06" → Date en hora LOCAL, que es como la leen los formateadores. */
function fechaLocal(iso: string): Date {
  const [a, m, d] = iso.split("-").map(Number);
  return new Date(a, m - 1, d);
}

/** "2024-07-06" → Date en UTC, para restar días sin que entre un horario de verano. */
function fechaUTC(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

/**
 * Corte a día del filtro de periodo, en días.
 *
 * Los 60 por omisión de `granularidadPorRango` son para el rango completo de un
 * reporte; aquí el rango lo elige la persona y el caso que motivó el filtro es
 * un trimestre (~90 días), que con 60 caía en "mes" y dejaba una serie de tres
 * puntos. Con 130 un trimestre se ve día a día y un semestre sigue siendo
 * mensual.
 */
const UMBRAL_DIA_PERIODO = 130;

/**
 * Todo lo que las gráficas y la tabla sacan de UN bundle.
 *
 * Existe porque la ficha tiene dos bundles a la vez: el del histórico completo
 * —lo que mira Overview— y el del periodo elegido, que miran Ventas y
 * Productos. Sin esto habría que duplicar cuatro `useMemo` casi idénticos, y es
 * justo el tipo de duplicado en el que uno de los dos se queda atrás.
 */
interface Derivados {
  /** Acumuladores por valor de la dimensión elegida; null sin dimensión. */
  acum: Map<string, Acumulador> | null;
  datosBarra: PuntoAgrupado[];
  datosComposicion: PuntoAgrupado[];
  /** Serie mensual sin plegar: de aquí salen la temporal y la comparativa anual. */
  mensual: Map<string, Acumulador> | null;
  producto: { campos: string[]; grupos: GrupoProducto[] } | null;
  totales: GrupoAcumulado | null;
  /**
   * Métricas del bundle del que salen estos grupos, en orden. Viaja con ellos
   * porque `valorMetricaAgregada` indexa `suma` por POSICIÓN: leer los grupos
   * de un bundle con la lista de métricas de otro daría cifras cambiadas de
   * columna sin que nada falle.
   */
  metricas: string[];
}

function derivar(
  bundle: Bundle | null,
  campoDimension: string | null,
  campoMetrica: string | null,
  agregacion: Agregacion
): Derivados {
  const metricas = bundle?.metricas ?? [];
  const grupos = campoDimension ? bundle?.dimensiones?.[campoDimension] : null;
  const acum = grupos ? acumuladoresDeGrupos(grupos, metricas, campoMetrica) : null;
  return {
    acum,
    datosBarra: acum ? plegarTopN(acum, agregacion, TOP_BARRA) : [],
    // La participación va siempre sobre la suma: un promedio no es aditivo.
    datosComposicion: acum
      ? plegarTopN(acum, campoMetrica ? "suma" : "conteo", TOP_COMPOSICION)
      : [],
    mensual: bundle?.serie
      ? acumuladoresDeGrupos(bundle.serie.grupos, metricas, campoMetrica)
      : null,
    producto: bundle?.producto ?? null,
    totales: bundle?.totales ?? null,
    metricas,
  };
}

export function RetailerDetalle({ ficha }: { ficha: DetalleRetailer }) {
  const router = useRouter();
  const [vista, setVista] = useState<Vista>("resumen");
  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [archivos, setArchivos] = useState<Archivo[] | null>(null);
  const [cargando, setCargando] = useState(ficha.reportes > 0);

  // Selección de los filtros, igual que en el analizador: índices de columna
  // para los selectores, campos de la plantilla para leer los acumuladores.
  const [campoDimension, setCampoDimension] = useState<string | null>(null);
  const [campoMetrica, setCampoMetrica] = useState<string | null>(null);
  const [paginaProductos, setPaginaProductos] = useState(1);
  // Campo por el que se ordena la tabla de productos, y en qué sentido. Viven
  // aparte de la métrica de las gráficas: esa pestaña dejó de compartir los
  // filtros de arriba. La dirección en null es "la que corresponda al campo".
  const [orden, setOrden] = useState<string | null>(null);
  const [direccion, setDireccion] = useState<Direccion | null>(null);
  const [busqueda, setBusqueda] = useState("");
  // Reporte abierto dentro de la pestaña de reportes; null = la lista.
  const [reporteAbierto, setReporteAbierto] = useState<string | null>(null);

  // --- Filtro de periodo ---------------------------------------------------
  // Los dos extremos, tal como están escritos en los inputs. Vacíos = todo el
  // histórico, que es lo que pide la carga inicial: así el primer viaje sigue
  // siendo el de siempre y Overview nunca se mueve.
  //
  // Un periodo SÍ cuesta un viaje, al revés que la métrica o la dimensión: las
  // ramas de dimensión y de producto del $facet agregan sin fecha, así que las
  // barras, la dona y la tabla de artículos no se pueden recortar aquí. Se pide
  // un segundo bundle acotado y Ventas y Productos leen ese.
  const [desdeEscrito, setDesdeEscrito] = useState("");
  const [hastaEscrito, setHastaEscrito] = useState("");
  // El bundle del periodo, con la clave a la que corresponde: guardarla dentro
  // del estado es lo que hace que una respuesta que llega tarde no se pinte
  // como si fuera del periodo que ya está elegido.
  const [bundleRango, setBundleRango] = useState<{ clave: string; bundle: Bundle } | null>(null);
  const [errorRango, setErrorRango] = useState(false);
  const [reintento, setReintento] = useState(0);
  // Serie diaria del periodo. Fuera del bundle por lo mismo que en el
  // analizador: son muchos más buckets y sólo hacen falta con un rango corto.
  const [serieDia, setSerieDia] = useState<{
    clave: string;
    metricas: string[];
    grupos: GrupoAcumulado[];
  } | null>(null);
  const rangoServido = useRef<string | null>(null);
  const diaServida = useRef<string | null>(null);

  // Retailer cuyo bundle ya se pidió. Mismo patrón que las claves servidas de
  // AnalisisExcel, y aquí hace falta por el doble montaje de React en
  // desarrollo: sin esto el efecto se ejecuta dos veces sobre la misma ficha y
  // salían DOS peticiones idénticas y simultáneas al resumen, que es la más
  // cara de la ruta.
  const fichaPedida = useRef<string | null>(null);

  const cargar = useCallback(async () => {
    if (ficha.reportes === 0) return;
    try {
      const q = `?account=${encodeURIComponent(ficha.id)}&alcance=cuenta`;
      const [b, h] = await Promise.all([
        api<Bundle>(`/api/retail/analisis/resumen${q}`),
        api<{ archivos: Archivo[] }>(`/api/retail/analisis?account=${encodeURIComponent(ficha.id)}`),
      ]);
      setBundle(b);
      setArchivos(h.archivos);
      setCampoDimension(b.seleccion?.dimension ?? null);
      setCampoMetrica(b.seleccion?.metrica ?? null);
    } catch {
      // Que no cargue no rompe la ficha: la cabecera ya tiene lo suyo del
      // servidor y las pestañas caen a su estado vacío.
      setBundle(null);
    } finally {
      setCargando(false);
    }
  }, [ficha.id, ficha.reportes]);

  useEffect(() => {
    // Cambiar de retailer sí vuelve a pedir; volver a montar el mismo, no.
    if (fichaPedida.current === ficha.id) return;
    fichaPedida.current = ficha.id;
    void cargar();
  }, [cargar, ficha.id]);

  // El rango CON DATOS del retailer: pone los topes de los inputs. Sale del
  // bundle del histórico y no del acotado, que se movería con cada elección.
  const rangoDatos: RangoISO | null = bundle?.rangoFechas ?? null;

  const estadoEscrito = estadoDelPeriodo(desdeEscrito, hastaEscrito);

  /**
   * El periodo que de verdad se aplica. Null = todo el histórico.
   *
   * Sólo con las DOS fechas. Con una sola, elegir el inicio ya movería las
   * gráficas —y costaría el viaje al servidor del bundle acotado— para un
   * periodo que no es el que se está por pedir: quien escribe "de enero" va
   * camino de "a marzo", no de "de enero a hoy".
   */
  const periodo: RangoISO | null = useMemo(
    () => (estadoEscrito === "listo" ? { desde: desdeEscrito, hasta: hastaEscrito } : null),
    [estadoEscrito, desdeEscrito, hastaEscrito]
  );

  /** Identidad de lo que se está pidiendo con periodo. Null = sin filtro. */
  const claveRango = periodo ? `${ficha.id}|${periodo.desde}|${periodo.hasta}` : null;
  /** El bundle del periodo ELEGIDO; null mientras llega o si falló. */
  const bundlePeriodo =
    claveRango && bundleRango?.clave === claveRango ? bundleRango.bundle : null;
  const cargandoRango = claveRango !== null && bundlePeriodo === null && !errorRango;

  // Grano de la serie de Ventas. Sin periodo va por mes, como siempre: el
  // bundle la trae así y el año dejaba un puñado de barras que ya dicen los
  // KPIs. Con periodo lo decide el rango, que es lo que hace que pedir un mes
  // suelto se vea día a día.
  const granVentas: Granularidad = periodo
    ? granularidadPorRango(
        fechaUTC(periodo.desde),
        fechaUTC(periodo.hasta),
        UMBRAL_DIA_PERIODO
      )
    : "mes";

  /** Escribir en los inputs (o limpiarlos). Limpiar no toca la red. */
  const cambiarPeriodo = useCallback((d: string, h: string) => {
    setDesdeEscrito(d);
    setHastaEscrito(h);
    setErrorRango(false);
    // Otro periodo es otro catálogo: quedarse en la página 7 mostraría un tramo
    // arbitrario de una lista que acaba de cambiar de largo.
    setPaginaProductos(1);
    if (!d && !h) {
      rangoServido.current = null;
      diaServida.current = null;
      setBundleRango(null);
      setSerieDia(null);
    }
  }, []);

  useEffect(() => {
    if (!periodo || !claveRango) return;
    if (rangoServido.current === claveRango) return;
    rangoServido.current = claveRango;

    const q = new URLSearchParams({
      account: ficha.id,
      alcance: "cuenta",
      desde: periodo.desde,
      hasta: periodo.hasta,
    });
    void api<Bundle>(`/api/retail/analisis/resumen?${q.toString()}`)
      .then((b) => setBundleRango({ clave: claveRango, bundle: b }))
      // Aquí NO vale el catch silencioso de `cargar`: sin el bundle del periodo
      // se pintaría el histórico completo bajo la etiqueta de un trimestre, que
      // es peor que no pintar nada. Se avisa y se deja reintentar.
      .catch(() => {
        rangoServido.current = null;
        setErrorRango(true);
      });
  }, [periodo, claveRango, ficha.id, reintento]);

  useEffect(() => {
    if (!periodo || !claveRango || granVentas !== "dia") return;
    if (serieDia?.clave === claveRango) return;
    if (diaServida.current === claveRango) return;
    diaServida.current = claveRango;

    const q = new URLSearchParams({
      account: ficha.id,
      alcance: "cuenta",
      parte: "serie",
      granularidad: "dia",
      desde: periodo.desde,
      hasta: periodo.hasta,
    });
    void api<{ metricas?: string[]; serie?: SerieAcumulada }>(
      `/api/retail/analisis/resumen?${q.toString()}`
    )
      .then((r) => {
        if (r.serie) {
          setSerieDia({ clave: claveRango, metricas: r.metricas ?? [], grupos: r.serie.grupos });
        }
      })
      // Si falla, la serie se queda en el grano mensual —que ya está en mano— y
      // el resto del periodo se ve igual. Volver a elegirlo reintenta.
      .catch(() => {
        diaServida.current = null;
      });
  }, [periodo, claveRango, granVentas, serieDia, ficha.id]);

  // Columnas de la plantilla del retailer: dan los nombres para mostrar y qué
  // se puede elegir como dimensión o como métrica.
  const plantilla = useMemo(
    () => (bundle?.archivo ? plantillaPorId(bundle.archivo.template) : null),
    [bundle]
  );

  const columnas = useMemo(
    () => (plantilla ? columnasHistorico(plantilla) : []),
    [plantilla]
  );

  const nombreDe = useCallback(
    (campo: string | null) => columnas.find((c) => c.campo === campo)?.nombre ?? null,
    [columnas]
  );

  const opcionesDimension = useMemo(
    () => columnas.filter((c) => Object.hasOwn(bundle?.dimensiones ?? {}, c.campo)),
    [columnas, bundle]
  );
  // Las dimensiones que manda el bundle ya son las que declara la plantilla;
  // las métricas no, porque el servidor suma TODAS (la tabla de productos pinta
  // una columna por cada una) y el selector ofrece sólo las declaradas.
  const opcionesMetrica = useMemo(
    () =>
      columnas.filter(
        (c) => c.filtro === "metrica" && (bundle?.metricas ?? []).includes(c.campo)
      ),
    [columnas, bundle]
  );

  // Sin selector: las métricas se suman siempre. Sin métrica elegida no hay
  // nada que sumar y lo único que queda es contar filas.
  const agregacionEfectiva: Agregacion = campoMetrica ? "suma" : "conteo";
  const nombreMetrica = nombreDe(campoMetrica) ?? "Cantidad de filas";
  // Contar filas nunca es dinero, así que sin métrica elegida esto es false
  // solo: `columnas.find` no encuentra el campo null.
  const metricaMoneda =
    columnas.find((c) => c.campo === campoMetrica)?.esMoneda ?? false;
  // La serie de Overview va siempre por mes: el bundle la trae con ese grano y
  // el año dejaba un puñado de barras que ya dicen los KPIs.
  const granEfectiva: Granularidad = "mes";

  // Lo que sale del histórico completo. Overview mira SÓLO esto: sus KPIs son
  // la foto del retailer y no la del periodo que alguien esté explorando en
  // Ventas, y por eso el selector de periodo no aparece en su fila de filtros.
  const base = useMemo(
    () => derivar(bundle, campoDimension, campoMetrica, agregacionEfectiva),
    [bundle, campoDimension, campoMetrica, agregacionEfectiva]
  );

  // Lo mismo pero del periodo. Null cuando no hay filtro —Ventas y Productos
  // caen entonces en `base`— y también mientras el bundle acotado viaja, que es
  // lo que hace que se pinte el esqueleto en vez del histórico completo con la
  // etiqueta de un trimestre.
  const filtrado = useMemo(
    () =>
      bundlePeriodo
        ? derivar(bundlePeriodo, campoDimension, campoMetrica, agregacionEfectiva)
        : null,
    [bundlePeriodo, campoDimension, campoMetrica, agregacionEfectiva]
  );

  /** Lo que miran Ventas y Productos. Null = el periodo todavía no está. */
  const datos = periodo ? filtrado : base;

  const serieResumen = useMemo(
    () => (base.mensual ? rellenarSerie(base.mensual, agregacionEfectiva, "mes") : null),
    [base, agregacionEfectiva]
  );

  // Comparativa año contra año, mes a mes.
  const anualResumen = useMemo(
    () => (base.mensual ? compararAnios(base.mensual, agregacionEfectiva) : null),
    [base, agregacionEfectiva]
  );

  // Serie de Ventas. Con periodo el grano lo decide el rango: mensual sale del
  // bundle acotado, anual se reagrupa recortando la clave y diario es la única
  // que cuesta otra petición. Mientras ésa no llega se pinta la mensual, así que
  // la gráfica se refina en vez de parpadear.
  const serieVentas = useMemo(() => {
    if (!datos) return null;
    if (granVentas === "dia") {
      if (serieDia && serieDia.clave === claveRango) {
        const mapa = acumuladoresDeGrupos(serieDia.grupos, serieDia.metricas, campoMetrica);
        return rellenarSerie(mapa, agregacionEfectiva, "dia");
      }
      return datos.mensual ? rellenarSerie(datos.mensual, agregacionEfectiva, "mes") : null;
    }
    if (!datos.mensual) return null;
    const mapa = granVentas === "anio" ? reagruparSerie(datos.mensual, 4) : datos.mensual;
    return rellenarSerie(mapa, agregacionEfectiva, granVentas);
  }, [datos, granVentas, serieDia, claveRango, campoMetrica, agregacionEfectiva]);

  /** Grano que de verdad se está pintando en Ventas (ver `serieVentas`). */
  const granPintada: Granularidad =
    granVentas === "dia" && serieDia?.clave !== claveRango ? "mes" : granVentas;

  // Comparativa anual de Ventas. Con un periodo dentro de UN año calendario se
  // compara ese mismo tramo del año anterior —T1 2026 contra T1 2025—, y para
  // eso hace falta la serie del HISTÓRICO completo: el año previo está fuera
  // del rango filtrado y no puede salir del bundle acotado. Un periodo a
  // caballo entre dos años no tiene "el año anterior", así que ahí se cae al
  // criterio de siempre sobre lo filtrado: los dos años que aparezcan.
  const anualVentas = useMemo(() => {
    if (!periodo) return anualResumen;
    if (!datos) return null;
    const ventana = ventanaDelRango(periodo.desde, periodo.hasta);
    if (ventana && base.mensual) return compararAnios(base.mensual, agregacionEfectiva, ventana);
    return datos.mensual ? compararAnios(datos.mensual, agregacionEfectiva) : null;
  }, [periodo, anualResumen, datos, base, agregacionEfectiva]);

  const kpis = useMemo(() => {
    if (!bundle?.totales) return null;
    const i = campoMetrica ? (bundle.metricas ?? []).indexOf(campoMetrica) : -1;
    return {
      totalMetrica: i < 0 ? bundle.totales.conteo : (bundle.totales.suma[i] ?? 0),
      totalFilas: bundle.totales.conteo,
      dimensionesDistintas: base.acum?.size ?? 0,
      rangoFechas: bundle.rangoFechas
        ? {
            desde: fechaLocal(bundle.rangoFechas.desde),
            hasta: fechaLocal(bundle.rangoFechas.hasta),
          }
        : null,
    };
  }, [bundle, campoMetrica, base]);

  // Los dos KPIs de la derecha miran el DESEMPEÑO del retailer y no el archivo
  // que lo trajo: cómo va el año contra el anterior y cuánto vale un mes
  // típico. Salen de lo que ya está calculado para las gráficas, así que
  // cambiar de métrica los mueve al mismo tiempo que ellas.
  const evolucion: EvolucionKpis = useMemo(() => {
    // Sólo el último año, no toda la historia: un promedio que arrastra los
    // años viejos deja de decir cómo va el retailer hoy. La serie llega
    // ordenada, así que el año es el del último punto.
    const serie = serieResumen ?? [];
    const anio = serie.length > 0 ? serie[serie.length - 1].clave.slice(0, 4) : null;
    const ultimoAnio = anio ? serie.filter((p) => p.clave.startsWith(anio)) : [];
    // Sumar los puntos vale porque la agregación fija es "suma" (o "conteo",
    // que también es aditivo): con "promedio" el promedio de los promedios
    // mensuales no sería el promedio del año.
    const total = ultimoAnio.reduce((acc, p) => acc + p.valor, 0);
    return {
      anual: anualResumen,
      // Los meses son los del año en curso hasta donde llega el reporte —no
      // doce fijos ni sólo los que vendieron—: la serie viene rellena, así que
      // un mes sin reportar ya cuenta como cero en la gráfica y tiene que
      // contar igual en el promedio.
      promedioMensual:
        anio && ultimoAnio.length > 0
          ? { valor: total / ultimoAnio.length, meses: ultimoAnio.length, anio: Number(anio) }
          : null,
    };
  }, [serieResumen, anualResumen]);

  // --- Pestaña de productos ------------------------------------------------
  // Una fila por producto —(nombre, UPC, marca), el grano que declara la
  // plantilla— con las métricas que esa misma plantilla elige mostrar. Sale de
  // la rama `producto` del bundle, no de una consulta nueva.
  //
  // Las columnas de identidad van primero y las de números después, que es como
  // se lee un catálogo: qué es el producto y luego cuánto vendió.
  const camposProductos = useMemo(
    () => [...(bundle?.producto?.campos ?? []), ...(plantilla?.producto?.metricas ?? [])],
    [bundle, plantilla]
  );

  const columnasProductos = useMemo<MetaColumna[]>(
    () =>
      camposProductos.map((campo, indice) => {
        const col = columnas.find((c) => c.campo === campo);
        return {
          indice,
          nombre: col?.nombre ?? campo,
          tipo: col?.tipo ?? "categoria",
          // El UPC es un código: sin separadores de miles y en mono.
          esIdentificador: col?.esIdentificador ?? false,
          // Importes con "$" en su columna: aquí conviven "Unidades" y "Ventas
          // netas", y sin el símbolo las dos se leen igual.
          esMoneda: col?.esMoneda ?? false,
          noVacias: 0,
          cardinalidad: 0,
          esConstante: false,
          magnitud: 0,
          formatoNumerico: "nativo" as const,
          ordenFecha: null,
        };
      }),
    [camposProductos, columnas]
  );

  /** Columnas de identidad: las que se buscan y las que ordenan alfabéticamente. */
  const nClavesProducto = bundle?.producto?.campos.length ?? 0;

  // Orden por omisión: la métrica preferida de la plantilla (Ventas netas), que
  // es por la que ya se ordenaba antes de que existiera el selector.
  const ordenEfectivo = useMemo(() => {
    if (orden && camposProductos.includes(orden)) return orden;
    const metricas = plantilla?.producto?.metricas ?? [];
    const preferida = bundle?.seleccion?.metrica;
    if (preferida && metricas.includes(preferida)) return preferida;
    return metricas[0] ?? camposProductos[0] ?? null;
  }, [orden, camposProductos, plantilla, bundle]);

  const iOrden = Math.max(0, camposProductos.indexOf(ordenEfectivo ?? ""));
  const ordenNumerico = iOrden >= nClavesProducto;
  // Por omisión, lo que se espera de cada tipo: los números de mayor a menor
  // —lo que se quiere de "ventas netas"— y el texto de la A a la Z. `direccion`
  // se limpia al cambiar de campo, así que pasar de Ventas netas a Marca abre
  // en A→Z y no en Z→A por arrastrar el "descendente" anterior.
  const direccionEfectiva: Direccion = direccion ?? (ordenNumerico ? "desc" : "asc");

  const filasProductos = useMemo<CeldaCruda[][]>(() => {
    // Del periodo si hay uno: la tabla de artículos responde al mismo filtro
    // que las gráficas de Ventas, así que sus cifras y las de las barras
    // hablan del mismo tramo.
    const grupos = datos?.producto?.grupos;
    if (!grupos) return [];
    // Cada métrica se junta como diga la plantilla y NO siempre sumando: las
    // dos columnas de promedio ("Precio promedio", "Venta promedio por tienda")
    // ya vienen promediadas por fila y sumarlas daba cifras absurdas.
    const metricasBundle = datos.metricas;
    const agregados = (plantilla?.producto?.metricas ?? []).map((campo) => ({
      campo,
      agregado: columnas.find((c) => c.campo === campo)?.agregado,
    }));
    const texto = busqueda.trim().toLowerCase();
    const filas = grupos
      // Se busca en TODAS las columnas de identidad: con el UPC y la marca a la
      // vista, teclear cualquiera de los dos y no encontrar nada sorprendería.
      .filter((g) => !texto || g.valores.some((v) => v.toLowerCase().includes(texto)))
      .map(
        (g) =>
          [
            ...g.valores,
            ...agregados.map((m) =>
              valorMetricaAgregada(g, metricasBundle, m.campo, m.agregado)
            ),
          ] as CeldaCruda[]
      );

    const signo = direccionEfectiva === "asc" ? 1 : -1;
    filas.sort(
      (a, b) =>
        signo *
        (ordenNumerico
          ? Number(a[iOrden] ?? 0) - Number(b[iOrden] ?? 0)
          : String(a[iOrden] ?? "").localeCompare(String(b[iOrden] ?? ""), "es"))
    );
    return filas;
  }, [datos, plantilla, columnas, busqueda, iOrden, ordenNumerico, direccionEfectiva]);

  const paginasProductos = Math.max(
    1,
    Math.ceil(filasProductos.length / PRODUCTOS_POR_PAGINA)
  );
  const paginaActual = Math.min(Math.max(1, paginaProductos), paginasProductos);
  const productosVisibles = useMemo(
    () =>
      filasProductos.slice(
        (paginaActual - 1) * PRODUCTOS_POR_PAGINA,
        paginaActual * PRODUCTOS_POR_PAGINA
      ),
    [filasProductos, paginaActual]
  );

  const sinDatos = ficha.reportes === 0;

  /**
   * En qué punto está el periodo. Ventas y Productos lo consultan antes de
   * pintar: mientras el bundle acotado viaja no se pinta el histórico completo
   * bajo la etiqueta de un trimestre, y un periodo sin ventas se dice con
   * palabras y no con cuatro paneles en cero.
   */
  const estadoPeriodo = cargandoRango
    ? "cargando"
    : errorRango
      ? "error"
      : periodo && (datos?.totales?.conteo ?? 0) === 0
        ? "vacio"
        : "listo";

  const filtroPeriodo =
    rangoDatos !== null ? (
      <SelectorPeriodo
        rangoDatos={rangoDatos}
        desde={desdeEscrito}
        hasta={hastaEscrito}
        estado={estadoEscrito}
        onCambio={cambiarPeriodo}
      />
    ) : null;

  // Dimensión y métrica: las comparten Overview y Ventas —las dos miran una
  // métrica a la vez, y por eso sus números concuerdan al cambiar de sección—,
  // pero el periodo sólo lo lleva Ventas.
  const filtrosGrafica = (
    <>
      {opcionesDimension.length > 0 ? (
        <Selector
          etiqueta="Dimensión"
          valor={campoDimension ?? ""}
          onCambio={setCampoDimension}
        >
          {opcionesDimension.map((c) => (
            <option key={c.campo} value={c.campo}>
              {c.nombre}
            </option>
          ))}
        </Selector>
      ) : null}

      <Selector
        etiqueta="Métrica"
        valor={campoMetrica ?? ""}
        onCambio={(v) => setCampoMetrica(v || null)}
      >
        {/* "Cantidad de filas" sólo como rescate: si la plantilla declara
            métricas, el selector habla de ventas y unidades y no de filas de
            un Excel. */}
        {opcionesMetrica.length === 0 ? <option value="">Cantidad de filas</option> : null}
        {opcionesMetrica.map((c) => (
          <option key={c.campo} value={c.campo}>
            {c.nombre}
          </option>
        ))}
      </Selector>
    </>
  );

  /** Lo que se pinta en Ventas y Productos cuando el periodo no está listo. */
  const avisoPeriodo =
    estadoPeriodo === "error" ? (
      <Panel>
        <div className="flex flex-col items-center gap-3 py-12 text-center">
          <p className="cr-body">No se pudieron cargar las ventas de este periodo.</p>
          <button
            type="button"
            className="cr-btn cr-btn--secondary cr-btn--sm"
            onClick={() => {
              setErrorRango(false);
              setReintento((n) => n + 1);
            }}
          >
            Reintentar
          </button>
        </div>
      </Panel>
    ) : estadoPeriodo === "vacio" ? (
      <Panel>
        <EstadoVacio
          title={`Sin ventas de ${ficha.nombre} en este periodo`}
          detalle="Los reportes guardados no cubren el rango elegido. Prueba con otro periodo o quita el filtro."
        />
      </Panel>
    ) : null;

  return (
    <>
      <header className="cr-detalle-head">
        <div className="cr-detalle-head__fila">
          <div className="flex min-w-0 items-center gap-2.5">
            <span
              aria-hidden="true"
              className="size-3 shrink-0"
              style={{ background: colorRetailer(ficha.id), borderRadius: "var(--cr-r-xs)" }}
            />
            <h1 className="cr-h1 truncate">{ficha.nombre}</h1>
            <Badge tono={sinDatos ? "neutro" : "ok"}>
              {sinDatos ? "Sin reportes" : "Con datos"}
            </Badge>
          </div>
          <Link href="/retail/analisis" className="cr-btn cr-btn--secondary cr-btn--sm">
            <FileSpreadsheet strokeWidth={1.75} />
            Cargar un Excel
          </Link>
        </div>

        {sinDatos ? null : (
          <div className="cr-detalle-head__fila">
            <span className="cr-mono cr-small">
              {fmtFecha(ficha.desde)} — {fmtFecha(ficha.hasta)}
            </span>
            <div className="flex min-w-48 flex-1 items-center gap-3">
              <div className="min-w-24 flex-1">
                <Meter value={ficha.participacion ?? 0} tono="ink" />
              </div>
              <span className="cr-small whitespace-nowrap">
                {fmtPct(ficha.participacion)} del importe total
              </span>
            </div>
          </div>
        )}

        <div className="cr-detalle-head__tabs">
          <div className="cr-segment" role="tablist">
            {VISTAS.map((v) => (
              <button
                key={v.id}
                type="button"
                role="tab"
                aria-selected={vista === v.id}
                onClick={() => {
                  setVista(v.id);
                  // Cambiar de pestaña vuelve a la lista: la ficha de un
                  // reporte no es un lugar al que se regrese "por detrás".
                  setReporteAbierto(null);
                }}
                className={`cr-segment__item${vista === v.id ? " cr-segment__item--active" : ""}`}
              >
                {v.etiqueta}
              </button>
            ))}
          </div>
          <div className="hidden items-center gap-4 sm:flex">
            <Metrica etiqueta="Último reporte" valor={fmtFecha(ficha.ultimoReporte)} />
            <Metrica etiqueta="Reportes" valor={fmtNum(ficha.reportes)} />
            <Metrica etiqueta="Artículos" valor={fmtNum(ficha.articulos)} />
          </div>
        </div>
      </header>

      <div className="cr-page-content flex flex-col gap-6">
        {sinDatos ? (
          <Panel>
            <EstadoVacio
              title={`Todavía no hay reportes de ${ficha.nombre}`}
              detalle="Sube su Excel desde Análisis y elige este retailer al guardarlo. Aparecerá aquí con sus ventas, sus productos y su histórico."
            >
              <FileSpreadsheet strokeWidth={1.25} size={28} style={{ color: "var(--cr-ink-3)" }} />
            </EstadoVacio>
          </Panel>
        ) : cargando ? (
          // El mismo esqueleto que sirvió de fallback a la ruta: la cabecera ya
          // es la de verdad —viene con la página— y debajo sigue la silueta del
          // contenido hasta que contestan los dos endpoints.
          <RetailerContenidoSkeleton />
        ) : !bundle?.archivo ? (
          <Panel>
            <p className="cr-body py-8 text-center">
              No se pudieron cargar los datos de este retailer. Recarga la página para
              reintentar.
            </p>
          </Panel>
        ) : (
          <>
            {/* Productos tiene su propio filtro: su tabla no depende de la
                dimensión ni de la métrica —muestra TODAS las columnas del
                producto a la vez—, así que lo único que queda por elegir ahí es
                el orden, más el periodo, que sí comparte con Ventas.

                Overview no lleva periodo a propósito: sus KPIs son la foto del
                retailer completo, y un selector encima de números que no lo
                respetan se leería como un filtro roto. */}
            {vista === "productos" ? (
              <div className="flex flex-wrap items-end gap-3">
                <Selector
                  etiqueta="Ordenar por"
                  valor={ordenEfectivo ?? ""}
                  onCambio={(v) => {
                    setOrden(v);
                    // El sentido vuelve al que le toca al campo nuevo.
                    setDireccion(null);
                    // Otro orden es otra página 1: quedarse en la 7 mostraría
                    // un tramo arbitrario de la lista recién reordenada.
                    setPaginaProductos(1);
                  }}
                >
                  {camposProductos.map((campo, i) => (
                    <option key={campo} value={campo}>
                      {columnasProductos[i]?.nombre ?? campo}
                    </option>
                  ))}
                </Selector>

                <Selector
                  etiqueta="Sentido"
                  valor={direccionEfectiva}
                  onCambio={(v) => {
                    setDireccion(v as Direccion);
                    setPaginaProductos(1);
                  }}
                >
                  {/* Las etiquetas hablan el idioma del campo: "mayor a menor"
                      de un texto o "A → Z" de un importe no se entienden. */}
                  <option value={ordenNumerico ? "desc" : "asc"}>
                    {ordenNumerico ? "Mayor a menor" : "A → Z"}
                  </option>
                  <option value={ordenNumerico ? "asc" : "desc"}>
                    {ordenNumerico ? "Menor a mayor" : "Z → A"}
                  </option>
                </Selector>

                {filtroPeriodo}
              </div>
            ) : vista === "reportes" ? null : (
              <div className="flex flex-wrap items-end gap-3">
                {filtrosGrafica}
                {vista === "ventas" ? filtroPeriodo : null}
              </div>
            )}

            {vista === "resumen" && kpis ? (
              <>
                <AnalisisKpis
                  kpis={kpis}
                  nombreMetrica={nombreMetrica}
                  nombreDimension={nombreDe(campoDimension)}
                  metricaMoneda={metricaMoneda}
                  evolucion={evolucion}
                />
                <AnalisisCharts
                  datosBarra={base.datosBarra}
                  datosSerie={serieResumen}
                  datosComposicion={base.datosComposicion}
                  datosAnual={anualResumen}
                  nombreDimension={nombreDe(campoDimension)}
                  nombreMetrica={nombreMetrica}
                  agregacion={agregacionEfectiva}
                  granularidad={granEfectiva}
                  metricaMoneda={metricaMoneda}
                />
              </>
            ) : null}

            {vista === "ventas" ? (
              estadoPeriodo === "cargando" ? (
                <div className="cr-pulse" aria-busy="true">
                  <RetailerGraficasSkeleton />
                </div>
              ) : estadoPeriodo !== "listo" ? (
                avisoPeriodo
              ) : (
                <AnalisisCharts
                  datosBarra={datos?.datosBarra ?? []}
                  datosSerie={serieVentas}
                  datosComposicion={datos?.datosComposicion ?? []}
                  datosAnual={anualVentas}
                  nombreDimension={nombreDe(campoDimension)}
                  nombreMetrica={nombreMetrica}
                  agregacion={agregacionEfectiva}
                  granularidad={granPintada}
                  metricaMoneda={metricaMoneda}
                />
              )
            ) : null}

            {vista === "productos" ? (
              estadoPeriodo === "cargando" ? (
                <div className="cr-pulse" aria-busy="true">
                  <RetailerTablaSkeleton />
                </div>
              ) : estadoPeriodo !== "listo" ? (
                avisoPeriodo
              ) : (
                <AnalisisTable
                  titulo="Artículos"
                  columnas={columnasProductos}
                  filasVisibles={productosVisibles}
                  totalFilas={datos?.producto?.grupos.length ?? 0}
                  totalFiltradas={filasProductos.length}
                  totalColumnas={columnasProductos.length}
                  detalles={[
                    // El periodo primero: es lo que decide de qué hablan las
                    // cifras, y el orden es sólo cómo están puestas.
                    ...(periodo
                      ? [`del ${fmtFecha(periodo.desde)} al ${fmtFecha(periodo.hasta)}`]
                      : []),
                    `ordenado por ${columnasProductos[iOrden]?.nombre ?? "—"} ${etiquetaSentido(
                      ordenNumerico,
                      direccionEfectiva
                    )}`,
                  ]}
                  busqueda={busqueda}
                  busquedaAplicada={busqueda}
                  onBusqueda={(v) => {
                    setBusqueda(v);
                    setPaginaProductos(1);
                  }}
                  columnasBuscadas={columnasProductos
                    .slice(0, nClavesProducto)
                    .map((c) => c.nombre)}
                  pagina={paginaActual}
                  paginas={paginasProductos}
                  porPagina={PRODUCTOS_POR_PAGINA}
                  onPagina={setPaginaProductos}
                />
              )
            ) : null}

            {vista === "reportes" ? (
              reporteAbierto ? (
                <ReporteDetalle
                  account={ficha.id}
                  sourceFile={reporteAbierto}
                  onVolver={() => setReporteAbierto(null)}
                  onBorrado={() => {
                    setReporteAbierto(null);
                    // El esqueleto mientras se recarga, y no la lista vieja: el
                    // reporte borrado seguiría en pantalla hasta que llegue la
                    // respuesta.
                    setCargando(true);
                    void cargar();
                    // La cabecera (reportes, artículos, periodo) la pinta el
                    // servidor: sin esto seguiría contando el reporte borrado.
                    router.refresh();
                  }}
                />
              ) : (
                <Panel title="Reportes guardados" sinPadding>
                  <div className="cr-table-scroll">
                    <table className="cr-table">
                      <thead>
                        <tr>
                          <th>Archivo</th>
                          <th>Subido por</th>
                          <th>Importado</th>
                          <th>Última actualización</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(archivos ?? []).length === 0 ? (
                          <tr>
                            <td colSpan={4} className="cr-body py-8 text-center">
                              Sin reportes guardados.
                            </td>
                          </tr>
                        ) : (
                          (archivos ?? []).map((a) => (
                            // El botón del nombre cubre toda la fila (ver
                            // .cr-fila-link), igual que en la lista de
                            // retailers: se puede hacer clic en cualquier parte
                            // sin meter un control por celda.
                            <tr key={a.sourceFile} className="cr-fila-link">
                              <td className="max-w-96 truncate">
                                <button
                                  type="button"
                                  className="cr-link block max-w-full cursor-pointer truncate text-left"
                                  title={a.sourceFile}
                                  onClick={() => setReporteAbierto(a.sourceFile)}
                                >
                                  {a.sourceFile}
                                </button>
                              </td>
                              <td className="max-w-64">
                                <AutorReporte usuario={a.subidoPor} />
                              </td>
                              <td className="cr-mono">{fmtFechaHora(a.importado)}</td>
                              {/* Un reporte que nunca se volvió a subir no
                                  tiene fecha de actualización, y la de
                                  importado no se mueve por eso. */}
                              <td className="cr-mono">
                                {a.actualizado ? fmtFechaHora(a.actualizado) : "—"}
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </Panel>
              )
            ) : null}
          </>
        )}
      </div>
    </>
  );
}

function Metrica({ etiqueta, valor }: { etiqueta: string; valor: string }) {
  return (
    <div className="text-right">
      <div className="cr-label">{etiqueta}</div>
      <div className="cr-mono">{valor}</div>
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
