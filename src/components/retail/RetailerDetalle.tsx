"use client";

// Ficha de un retailer: cabecera con estado y métricas, barra de pestañas y un
// panel por sección.
//
// Las cuatro pestañas se sirven del MISMO bundle de acumuladores, así que
// cambiar de sección —y de métrica, dimensión o granularidad dentro de ella— no
// vuelve a pedir nada. Es el mismo trato que /retail/analisis: Mongo agrega una
// vez y el navegador pliega, porque el enlace a la base es lento.

import Link from "next/link";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { FileSpreadsheet } from "lucide-react";
import { api } from "@/components/lib/api-client";
import { fmtFecha, fmtFechaHora, fmtNum, fmtPct } from "@/components/lib/fmt";
import { AnalisisKpis } from "@/components/retail/AnalisisKpis";
import { AnalisisTable } from "@/components/retail/AnalisisTable";
import { AutorReporte, type UsuarioReporte } from "@/components/retail/AutorReporte";
import { ReporteDetalle } from "@/components/retail/ReporteDetalle";
import { Badge, EstadoVacio, Meter, Panel } from "@/components/ui/basicos";
import {
  acumuladoresDeGrupos,
  plegarTopN,
  reagruparSerie,
  rellenarSerie,
  type GrupoAcumulado,
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
const AnalisisCharts = dynamic(() => import("@/components/retail/AnalisisCharts"), {
  ssr: false,
  loading: () => <div className="cr-panel cr-pulse" style={{ height: 420 }} />,
});

const TOP_BARRA = 8;
const TOP_COMPOSICION = 5;
const PRODUCTOS_POR_PAGINA = 100;

type Vista = "resumen" | "ventas" | "productos" | "reportes";

const VISTAS: { id: Vista; etiqueta: string }[] = [
  { id: "resumen", etiqueta: "Resumen" },
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
  const [agregacion, setAgregacion] = useState<Agregacion>("suma");
  const [granManual, setGranManual] = useState<Granularidad | null>(null);
  const [paginaProductos, setPaginaProductos] = useState(1);
  const [busqueda, setBusqueda] = useState("");
  // Reporte abierto dentro de la pestaña de reportes; null = la lista.
  const [reporteAbierto, setReporteAbierto] = useState<string | null>(null);

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
      setAgregacion(b.seleccion?.metrica ? "suma" : "conteo");
    } catch {
      // Que no cargue no rompe la ficha: la cabecera ya tiene lo suyo del
      // servidor y las pestañas caen a su estado vacío.
      setBundle(null);
    } finally {
      setCargando(false);
    }
  }, [ficha.id, ficha.reportes]);

  useEffect(() => {
    // fetch-on-mount: el flag de carga arranca activo
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void cargar();
  }, [cargar]);

  // Columnas de la plantilla del retailer: dan los nombres para mostrar y qué
  // se puede elegir como dimensión o como métrica.
  const columnas = useMemo(() => {
    const p = bundle?.archivo ? plantillaPorId(bundle.archivo.template) : null;
    return p ? columnasHistorico(p) : [];
  }, [bundle]);

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

  const agregacionEfectiva: Agregacion = campoMetrica ? agregacion : "conteo";
  const nombreMetrica = nombreDe(campoMetrica) ?? "Cantidad de filas";
  // Contar filas nunca es dinero, así que sin métrica elegida esto es false
  // solo: `columnas.find` no encuentra el campo null.
  const metricaMoneda =
    columnas.find((c) => c.campo === campoMetrica)?.esMoneda ?? false;
  const granEfectiva: Granularidad = granManual ?? bundle?.granularidad ?? "mes";

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
    // El bundle trae la serie mensual; el año se obtiene recortando la clave.
    // El día necesitaría otra petición y aquí no se ofrece.
    return rellenarSerie(
      granEfectiva === "anio" ? reagruparSerie(mensual, 4) : mensual,
      agregacionEfectiva,
      granEfectiva === "anio" ? "anio" : "mes"
    );
  }, [bundle, campoMetrica, agregacionEfectiva, granEfectiva]);

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

  // --- Pestaña de productos ------------------------------------------------
  // Una fila por artículo con TODAS sus métricas. Sale de los acumuladores de
  // la dimensión de artículo, no de una consulta nueva.
  const columnasProductos = useMemo<MetaColumna[]>(() => {
    const desc = columnas.find((c) => c.campo === "itemDesc");
    return [
      { ...(desc ?? columnas[0]), indice: 0, nombre: desc?.nombre ?? "Artículo" },
      ...(bundle?.metricas ?? []).map((campo, i) => {
        const col = columnas.find((c) => c.campo === campo);
        return {
          indice: i + 1,
          nombre: col?.nombre ?? campo,
          tipo: "numero" as const,
          // Importes con "$" en su columna: aquí conviven "Unidades" y "Ventas
          // netas", y sin el símbolo las dos se leen igual.
          esMoneda: col?.esMoneda ?? false,
          noVacias: 0,
          cardinalidad: 0,
          esIdentificador: false,
          esConstante: false,
          magnitud: 0,
          formatoNumerico: "nativo" as const,
          ordenFecha: null,
        };
      }),
    ].filter(Boolean) as MetaColumna[];
  }, [columnas, bundle]);

  const filasProductos = useMemo<CeldaCruda[][]>(() => {
    const grupos = bundle?.dimensiones?.itemDesc;
    if (!grupos) return [];
    const i = campoMetrica ? (bundle?.metricas ?? []).indexOf(campoMetrica) : -1;
    const texto = busqueda.trim().toLowerCase();
    return grupos
      .filter((g) => !texto || g.clave.toLowerCase().includes(texto))
      .slice()
      .sort((a, b) => (i < 0 ? b.conteo - a.conteo : (b.suma[i] ?? 0) - (a.suma[i] ?? 0)))
      .map((g) => [g.clave, ...g.suma] as CeldaCruda[]);
  }, [bundle, campoMetrica, busqueda]);

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
          <div className="flex flex-col gap-6" aria-busy="true">
            <div className="cr-panel cr-pulse" style={{ height: 96 }} />
            <div className="cr-panel cr-pulse" style={{ height: 320 }} />
          </div>
        ) : !bundle?.archivo ? (
          <Panel>
            <p className="cr-body py-8 text-center">
              No se pudieron cargar los datos de este retailer. Recarga la página para
              reintentar.
            </p>
          </Panel>
        ) : (
          <>
            {/* Los filtros viven fuera de las pestañas: los mismos mandan sobre
                Resumen, Ventas y Productos, así que los números concuerdan al
                cambiar de sección. */}
            {vista === "reportes" ? null : (
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
                  onCambio={(v) => {
                    setCampoMetrica(v || null);
                    // Elegir una métrica saca de "Conteo", que ya no se ofrece.
                    if (v) setAgregacion((a) => (a === "conteo" ? "suma" : a));
                  }}
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

                {campoMetrica ? (
                  <Selector
                    etiqueta="Agregación"
                    valor={agregacion}
                    onCambio={(v) => setAgregacion(v as Agregacion)}
                  >
                    {/* Sin "Conteo": contaba filas del reporte y no ventas.
                        Mismo criterio que en /retail/analisis. */}
                    <option value="suma">Suma</option>
                    <option value="promedio">Promedio</option>
                  </Selector>
                ) : null}

                {vista === "ventas" ? (
                  <Selector
                    etiqueta="Granularidad"
                    valor={granEfectiva}
                    onCambio={(v) => setGranManual(v as Granularidad)}
                  >
                    <option value="mes">Mes</option>
                    <option value="anio">Año</option>
                  </Selector>
                ) : null}
              </div>
            )}

            {vista === "resumen" && kpis ? (
              <>
                <AnalisisKpis
                  kpis={kpis}
                  nombreMetrica={nombreMetrica}
                  nombreDimension={nombreDe(campoDimension)}
                  metricaMoneda={metricaMoneda}
                />
                <AnalisisCharts
                  datosBarra={datosBarra}
                  datosSerie={datosSerie}
                  datosComposicion={datosComposicion}
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
                totalFilas={bundle.dimensiones?.itemDesc?.length ?? 0}
                totalFiltradas={filasProductos.length}
                totalColumnas={columnasProductos.length}
                // La cabecera cuenta artículos por código y esta tabla agrupa
                // por descripción, así que los dos números pueden no coincidir
                // (dos códigos con la misma descripción son una sola fila). Se
                // dice en pantalla en vez de dejar que parezca un descuadre.
                detalles={[
                  "agrupado por descripción",
                  `acumulado de ${fmtNum(bundle.archivo.total)} filas`,
                  `ordenado por ${nombreMetrica}`,
                ]}
                busqueda={busqueda}
                busquedaAplicada={busqueda}
                onBusqueda={(v) => {
                  setBusqueda(v);
                  setPaginaProductos(1);
                }}
                columnasBuscadas={[columnasProductos[0]?.nombre ?? "Artículo"]}
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
