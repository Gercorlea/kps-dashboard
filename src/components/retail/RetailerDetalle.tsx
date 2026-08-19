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
} from "@/components/retail/RetailerSkeleton";
import { Badge, EstadoVacio, Meter, Panel } from "@/components/ui/basicos";
import {
  acumuladoresDeGrupos,
  compararAnios,
  plegarTopN,
  rellenarSerie,
  valorMetricaAgregada,
  type GrupoAcumulado,
  type GrupoProducto,
} from "@/lib/retail/analisis/agregar";
import { columnasHistorico, plantillaPorId } from "@/lib/retail/analisis/plantillas";
import { colorRetailer } from "@/lib/retail/retailers";
import type { DetalleRetailer } from "@/lib/retail/stats";
import type {
  Agregacion,
  CeldaCruda,
  Granularidad,
  MetaColumna,
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
  // La serie va siempre por mes: el bundle la trae con ese grano y el año
  // dejaba un puñado de barras que ya dicen los KPIs.
  const granEfectiva: Granularidad = "mes";

  // Acumuladores de la dimensión y la métrica elegidas. Todo lo de abajo sale
  // de aquí sin tocar la red.
  const acum = useMemo(() => {
    const grupos = campoDimension ? bundle?.dimensiones?.[campoDimension] : null;
    return grupos ? acumuladoresDeGrupos(grupos, bundle?.metricas ?? [], campoMetrica) : null;
  }, [bundle, campoDimension, campoMetrica]);

  const datosBarra = useMemo(
    () => (acum ? plegarTopN(acum, agregacionEfectiva, TOP_BARRA) : []),
    [acum, agregacionEfectiva]
  );

  // La participación va siempre sobre la suma: un promedio no es aditivo.
  const datosComposicion = useMemo(
    () => (acum ? plegarTopN(acum, campoMetrica ? "suma" : "conteo", TOP_COMPOSICION) : []),
    [acum, campoMetrica]
  );

  const datosSerie = useMemo(() => {
    if (!bundle?.serie) return null;
    const mensual = acumuladoresDeGrupos(
      bundle.serie.grupos,
      bundle.metricas ?? [],
      campoMetrica
    );
    // El bundle ya trae la serie mensual; el día necesitaría otra petición y
    // aquí no se ofrece.
    return rellenarSerie(mensual, agregacionEfectiva, "mes");
  }, [bundle, campoMetrica, agregacionEfectiva]);

  // Comparativa año contra año, mes a mes.
  const datosAnual = useMemo(() => {
    if (!bundle?.serie) return null;
    const mensual = acumuladoresDeGrupos(
      bundle.serie.grupos,
      bundle.metricas ?? [],
      campoMetrica
    );
    return compararAnios(mensual, agregacionEfectiva);
  }, [bundle, campoMetrica, agregacionEfectiva]);

  const kpis = useMemo(() => {
    if (!bundle?.totales) return null;
    const i = campoMetrica ? (bundle.metricas ?? []).indexOf(campoMetrica) : -1;
    return {
      totalMetrica: i < 0 ? bundle.totales.conteo : (bundle.totales.suma[i] ?? 0),
      totalFilas: bundle.totales.conteo,
      dimensionesDistintas: acum?.size ?? 0,
      rangoFechas: bundle.rangoFechas
        ? {
            desde: fechaLocal(bundle.rangoFechas.desde),
            hasta: fechaLocal(bundle.rangoFechas.hasta),
          }
        : null,
    };
  }, [bundle, campoMetrica, acum]);

  // Los dos KPIs de la derecha miran el DESEMPEÑO del retailer y no el archivo
  // que lo trajo: cómo va el año contra el anterior y cuánto vale un mes
  // típico. Salen de lo que ya está calculado para las gráficas, así que
  // cambiar de métrica los mueve al mismo tiempo que ellas.
  const evolucion: EvolucionKpis = useMemo(() => {
    // Sólo el último año, no toda la historia: un promedio que arrastra los
    // años viejos deja de decir cómo va el retailer hoy. La serie llega
    // ordenada, así que el año es el del último punto.
    const serie = datosSerie ?? [];
    const anio = serie.length > 0 ? serie[serie.length - 1].clave.slice(0, 4) : null;
    const ultimoAnio = anio ? serie.filter((p) => p.clave.startsWith(anio)) : [];
    // Sumar los puntos vale porque la agregación fija es "suma" (o "conteo",
    // que también es aditivo): con "promedio" el promedio de los promedios
    // mensuales no sería el promedio del año.
    const total = ultimoAnio.reduce((acc, p) => acc + p.valor, 0);
    return {
      anual: datosAnual,
      // Los meses son los del año en curso hasta donde llega el reporte —no
      // doce fijos ni sólo los que vendieron—: la serie viene rellena, así que
      // un mes sin reportar ya cuenta como cero en la gráfica y tiene que
      // contar igual en el promedio.
      promedioMensual:
        anio && ultimoAnio.length > 0
          ? { valor: total / ultimoAnio.length, meses: ultimoAnio.length, anio: Number(anio) }
          : null,
    };
  }, [datosSerie, datosAnual]);

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
    const grupos = bundle?.producto?.grupos;
    if (!grupos) return [];
    // Cada métrica se junta como diga la plantilla y NO siempre sumando: las
    // dos columnas de promedio ("Precio promedio", "Venta promedio por tienda")
    // ya vienen promediadas por fila y sumarlas daba cifras absurdas.
    const metricasBundle = bundle?.metricas ?? [];
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
  }, [bundle, plantilla, columnas, busqueda, iOrden, ordenNumerico, direccionEfectiva]);

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
                el orden. Los de abajo mandan sobre Overview y Ventas, que sí
                miran una métrica a la vez, y por eso los números de las dos
                concuerdan al cambiar de sección. */}
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
              </div>
            ) : vista === "reportes" ? null : (
              <div className="flex flex-wrap items-end gap-3">
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
                  {/* "Cantidad de filas" sólo como rescate: si la plantilla
                      declara métricas, el selector habla de ventas y unidades y
                      no de filas de un Excel. */}
                  {opcionesMetrica.length === 0 ? (
                    <option value="">Cantidad de filas</option>
                  ) : null}
                  {opcionesMetrica.map((c) => (
                    <option key={c.campo} value={c.campo}>
                      {c.nombre}
                    </option>
                  ))}
                </Selector>
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
                  datosBarra={datosBarra}
                  datosSerie={datosSerie}
                  datosComposicion={datosComposicion}
                  datosAnual={datosAnual}
                  nombreDimension={nombreDe(campoDimension)}
                  nombreMetrica={nombreMetrica}
                  agregacion={agregacionEfectiva}
                  granularidad={granEfectiva}
                  metricaMoneda={metricaMoneda}
                />
              </>
            ) : null}

            {vista === "ventas" ? (
              <AnalisisCharts
                datosBarra={datosBarra}
                datosSerie={datosSerie}
                datosComposicion={datosComposicion}
                datosAnual={datosAnual}
                nombreDimension={nombreDe(campoDimension)}
                nombreMetrica={nombreMetrica}
                agregacion={agregacionEfectiva}
                granularidad={granEfectiva}
                metricaMoneda={metricaMoneda}
              />
            ) : null}

            {vista === "productos" ? (
              <AnalisisTable
                titulo="Artículos"
                columnas={columnasProductos}
                filasVisibles={productosVisibles}
                totalFilas={bundle.producto?.grupos.length ?? 0}
                totalFiltradas={filasProductos.length}
                totalColumnas={columnasProductos.length}
                detalles={[
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
