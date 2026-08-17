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
import { useCallback, useEffect, useMemo, useState } from "react";
import { FileSpreadsheet } from "lucide-react";
import { api } from "@/components/lib/api-client";
import { fmtFecha, fmtFechaHora, fmtNum, fmtPct } from "@/components/lib/fmt";
import { AnalisisKpis } from "@/components/retail/AnalisisKpis";
import { AnalisisTable } from "@/components/retail/AnalisisTable";
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

interface Archivo {
  sourceFile: string;
  filas: number;
  importedAt: string | null;
}

/** "2024-07-06" → Date en hora LOCAL, que es como la leen los formateadores. */
function fechaLocal(iso: string): Date {
  const [a, m, d] = iso.split("-").map(Number);
  return new Date(a, m - 1, d);
}

export function RetailerDetalle({ ficha }: { ficha: DetalleRetailer }) {
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
  const opcionesMetrica = useMemo(
    () => columnas.filter((c) => (bundle?.metricas ?? []).includes(c.campo)),
    [columnas, bundle]
  );

  const agregacionEfectiva: Agregacion = campoMetrica ? agregacion : "conteo";
  const nombreMetrica = nombreDe(campoMetrica) ?? "Cantidad de filas";
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
            Analizar un Excel
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
                onClick={() => setVista(v.id)}
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
                  onCambio={(v) => setCampoMetrica(v || null)}
                >
                  <option value="">Cantidad de filas</option>
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
                    <option value="suma">Suma</option>
                    <option value="promedio">Promedio</option>
                    <option value="conteo">Conteo</option>
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
                />
                <AnalisisCharts
                  datosBarra={datosBarra}
                  datosSerie={datosSerie}
                  datosComposicion={datosComposicion}
                  nombreDimension={nombreDe(campoDimension)}
                  nombreMetrica={nombreMetrica}
                  agregacion={agregacionEfectiva}
                  granularidad={granEfectiva}
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
              <Panel title="Reportes guardados" sinPadding>
                <div className="cr-table-scroll">
                  <table className="cr-table">
                    <thead>
                      <tr>
                        <th>Archivo</th>
                        <th className="num">Filas</th>
                        <th>Importado</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(archivos ?? []).length === 0 ? (
                        <tr>
                          <td colSpan={3} className="cr-body py-8 text-center">
                            Sin reportes guardados.
                          </td>
                        </tr>
                      ) : (
                        (archivos ?? []).map((a) => (
                          <tr key={a.sourceFile}>
                            <td className="max-w-96 truncate" title={a.sourceFile}>
                              {a.sourceFile}
                            </td>
                            <td className="num">{fmtNum(a.filas)}</td>
                            <td className="cr-mono">{fmtFechaHora(a.importedAt)}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </Panel>
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
