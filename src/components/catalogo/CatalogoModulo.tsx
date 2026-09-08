"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Package } from "lucide-react";
import { api, ClientApiError } from "@/components/lib/api-client";
import { CargarCatalogo, type EstadoCarga } from "@/components/catalogo/CargarCatalogo";
import { FichaProducto } from "@/components/catalogo/FichaProducto";
import { TablaCatalogo } from "@/components/catalogo/TablaCatalogo";
import { TablaMapeo } from "@/components/catalogo/TablaMapeo";
import { AnalisisUploader } from "@/components/retail/AnalisisUploader";
import { BarraSegmentada } from "@/components/ui/BarraSegmentada";
import { Aviso, EstadoVacio } from "@/components/ui/basicos";
import { leerCatalogo } from "@/lib/catalogo/leer-excel";
import {
  CAMPOS_CATALOGO,
  CAMPOS_MAPEO,
  type FilaCatalogo,
  type FilaMapeo,
  type ResumenCatalogo,
} from "@/lib/catalogo/tipos";
import { normalizarBusqueda, paginar, totalPaginas } from "@/lib/retail/analisis/filtrar";
import { ErrorExcel, LIMITE_AVISO_BYTES } from "@/lib/retail/analisis/parsear";
import {
  MAX_FILAS_LOTE_CATALOGO,
  PRODUCTOS_POR_PAGINA_CATALOGO,
} from "@/lib/validation/catalogo";

type Vista = "catalogo" | "mapeo";

const VISTAS: { id: Vista; etiqueta: string }[] = [
  { id: "catalogo", etiqueta: "Catálogo" },
  { id: "mapeo", etiqueta: "Mapeo de productos" },
];

/** Respuesta de las dos rutas de tabla: filas como arreglos. */
interface RespuestaTabla {
  carga: { loadId: string } | null;
  filas: unknown[][];
  total: number;
}

/** Reconstruye objetos a partir de los arreglos que manda el servidor. */
function aFilas<T>(campos: readonly string[], filas: unknown[][]): T[] {
  return filas.map((f) => {
    const o: Record<string, unknown> = {};
    campos.forEach((c, i) => {
      o[c] = f[i];
    });
    return o as T;
  });
}

/** Texto buscable de una fila, ya normalizado. */
function textoDe(valores: unknown[]): string {
  return normalizarBusqueda(valores.map((v) => (v === null ? "" : String(v))).join(" "));
}

/** Trocea para mandar por lotes. */
function trozos<T>(filas: T[], tamano: number): T[][] {
  const salida: T[][] = [];
  for (let i = 0; i < filas.length; i += tamano) salida.push(filas.slice(i, i + tamano));
  return salida;
}

/**
 * El módulo de catálogo: carga, tabla de productos, tabla de mapeo y ficha.
 *
 * Único punto de entrada de cliente del módulo —los demás componentes entran al
 * bundle por importación—, igual que AnalisisExcel en el analizador.
 *
 * Las dos tablas se traen COMPLETAS y se filtran y paginan aquí, en `useMemo`.
 * Es lo que permite que el buscador responda en cada tecla sin ir al servidor;
 * la escala lo consiente con mucho margen (~140 productos). Ver la nota en
 * app/api/catalogo/productos/route.ts.
 */
export function CatalogoModulo() {
  const router = useRouter();

  const [resumen, setResumen] = useState<ResumenCatalogo | null>(null);
  const [productos, setProductos] = useState<FilaCatalogo[]>([]);
  const [mapeos, setMapeos] = useState<FilaMapeo[]>([]);
  const [cargandoDatos, setCargandoDatos] = useState(true);

  const [vista, setVista] = useState<Vista>("catalogo");
  const [pagina, setPagina] = useState(1);
  const [busqueda, setBusqueda] = useState("");
  const [linea, setLinea] = useState("");
  const [estatus, setEstatus] = useState("");
  const [canal, setCanal] = useState("");
  const [itemAbierto, setItemAbierto] = useState<string | null>(null);

  const [estado, setEstado] = useState<EstadoCarga>("inactivo");
  const [progreso, setProgreso] = useState(0);
  const [error, setError] = useState<{ titulo: string; detalle?: string } | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);

  const recargar = useCallback(async () => {
    setCargandoDatos(true);
    try {
      const [r, p, m] = await Promise.all([
        api<ResumenCatalogo>("/api/catalogo/resumen"),
        api<RespuestaTabla>("/api/catalogo/productos"),
        api<RespuestaTabla>("/api/catalogo/mapeo"),
      ]);
      setResumen(r);
      setProductos(aFilas<FilaCatalogo>(CAMPOS_CATALOGO, p.filas));
      setMapeos(aFilas<FilaMapeo>(CAMPOS_MAPEO, m.filas));
    } catch (e) {
      setError({
        titulo: "No se pudo cargar el catálogo",
        detalle: e instanceof ClientApiError ? e.message : "Vuelve a intentarlo en un momento.",
      });
    } finally {
      setCargandoDatos(false);
    }
  }, []);

  useEffect(() => {
    // Carga inicial; `cargandoDatos` arranca en true. Mismo patrón que
    // PeticionesAdmin: la regla existe para evitar renders en cascada, y aquí
    // el setState llega dentro de una promesa, no en el cuerpo del efecto.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void recargar();
  }, [recargar]);

  // --- Carga del archivo ---------------------------------------------------

  const alArchivo = useCallback(
    async (file: File) => {
      setError(null);
      setEstado("leyendo");
      setProgreso(0);
      setAviso(
        file.size > LIMITE_AVISO_BYTES
          ? `El archivo pesa ${Math.round(file.size / 1024 / 1024)} MB; leerlo puede tardar unos segundos.`
          : null
      );

      // setEstado por sí solo no pinta el spinner: React agrupa las
      // actualizaciones y la lectura bloquea justo el frame que lo dibujaría.
      await new Promise((r) => requestAnimationFrame(() => r(null)));

      let loadId: string | null = null;
      try {
        const lectura = await leerCatalogo(file);

        setEstado("subiendo");
        const abierta = await api<{ loadId: string }>("/api/catalogo/cargas", {
          method: "POST",
          body: JSON.stringify({
            filename: file.name,
            sizeBytes: file.size,
            productSheet: lectura.productSheet,
            mappingSheet: lectura.mappingSheet,
            declaredProducts: lectura.productos.length,
            declaredMappings: lectura.mapeos.length,
            discardedProducts: lectura.descartadas.productos,
            discardedMappings: lectura.descartadas.mapeos,
          }),
        });
        loadId = abierta.loadId;

        // El catálogo anterior sigue siendo el activo durante toda esta parte:
        // nada de lo que se escribe aquí lo ve nadie hasta finalizar.
        const lotesProductos = trozos(lectura.productos, MAX_FILAS_LOTE_CATALOGO);
        const lotesMapeo = trozos(lectura.mapeos, MAX_FILAS_LOTE_CATALOGO);
        const totalLotes = lotesProductos.length + lotesMapeo.length;
        let hechos = 0;

        for (const filas of lotesProductos) {
          await api(`/api/catalogo/cargas/${loadId}/filas`, {
            method: "POST",
            body: JSON.stringify({ tipo: "productos", filas }),
          });
          hechos++;
          setProgreso(hechos / totalLotes);
        }
        for (const filas of lotesMapeo) {
          await api(`/api/catalogo/cargas/${loadId}/filas`, {
            method: "POST",
            body: JSON.stringify({ tipo: "mapeo", filas }),
          });
          hechos++;
          setProgreso(hechos / totalLotes);
        }

        setEstado("finalizando");
        const fin = await api<{ reemplazoInesperado: boolean }>(
          `/api/catalogo/cargas/${loadId}/finalizar`,
          {
            method: "POST",
            body: JSON.stringify({
              incidencias: lectura.incidencias,
              loadIdPrevio: resumen?.carga?.loadId ?? null,
            }),
          }
        );

        setEstado("inactivo");
        setPagina(1);
        setBusqueda("");
        await recargar();
        // La página es RSC; sin esto, volver con Atrás mostraría el estado
        // anterior a la carga.
        router.refresh();

        if (fin.reemplazoInesperado) {
          setAviso(
            "Alguien más subió un catálogo mientras se leía este archivo. El tuyo reemplazó el suyo."
          );
        }
      } catch (e) {
        // Descartar la carga a medias es best-effort: si no llega, se queda en
        // "loading" —igual de invisible— y el barrido la limpia después.
        if (loadId) {
          void api(`/api/catalogo/cargas/${loadId}`, { method: "DELETE" }).catch(() => {});
        }
        setEstado("inactivo");
        setProgreso(0);
        if (e instanceof ErrorExcel) {
          setError({ titulo: e.message, detalle: e.sugerencia });
        } else if (e instanceof ClientApiError) {
          setError({
            titulo: e.message,
            detalle: "El catálogo anterior sigue intacto; vuelve a subir el archivo.",
          });
        } else {
          setError({
            titulo: "Ocurrió un error inesperado al cargar el archivo.",
            detalle: "El catálogo anterior sigue intacto; vuelve a intentarlo.",
          });
        }
      }
    },
    // `resumen` completo y no sólo su loadId: el compilador de React infiere esa
    // dependencia y con la más estrecha se salta la optimización del componente.
    [recargar, resumen, router]
  );

  // --- Filtrado y paginación, en el navegador -----------------------------

  const termino = useMemo(() => normalizarBusqueda(busqueda), [busqueda]);

  const productosFiltrados = useMemo(() => {
    return productos.filter((p) => {
      if (linea && p.line.toLowerCase() !== linea) return false;
      if (estatus && p.status.toLowerCase() !== estatus) return false;
      if (!termino) return true;
      // Se busca en TODAS las columnas visibles: con el UPC y la línea a la
      // vista, teclear cualquiera de los dos y no encontrar nada sorprendería.
      return textoDe([
        p.item,
        p.description,
        p.salesUnit,
        p.status,
        p.line,
        p.upc,
        p.launchDate,
        p.launchDateText,
      ]).includes(termino);
    });
  }, [productos, linea, estatus, termino]);

  const mapeosFiltrados = useMemo(() => {
    return mapeos.filter((m) => {
      if (canal && m.channel !== canal) return false;
      if (!termino) return true;
      return textoDe([m.sku, m.channelName, m.channel, m.customerCode, m.description]).includes(
        termino
      );
    });
  }, [mapeos, canal, termino]);

  const enCatalogo = vista === "catalogo";
  // Las dos vistas comparten el estado de página, así que el total de páginas
  // es el de la tabla que se está mirando.
  const totalVisible = enCatalogo ? productosFiltrados.length : mapeosFiltrados.length;
  const paginas = totalPaginas(totalVisible, PRODUCTOS_POR_PAGINA_CATALOGO);
  const paginaActual = Math.min(Math.max(1, pagina), paginas);

  const productosVisibles = useMemo(
    () => paginar(productosFiltrados, paginaActual, PRODUCTOS_POR_PAGINA_CATALOGO),
    [productosFiltrados, paginaActual]
  );
  const mapeosVisibles = useMemo(
    () => paginar(mapeosFiltrados, paginaActual, PRODUCTOS_POR_PAGINA_CATALOGO),
    [mapeosFiltrados, paginaActual]
  );

  /** Buscar o filtrar devuelve a la página 1: si no, se vería una tabla vacía. */
  const buscar = useCallback((v: string) => {
    setBusqueda(v);
    setPagina(1);
  }, []);

  const carga = resumen?.carga ?? null;
  const avisosCarga = carga?.incidencias.filter((i) => i.severity === "aviso") ?? [];

  // --- Estado vacío --------------------------------------------------------

  if (!cargandoDatos && !carga) {
    return (
      <div className="flex flex-col gap-4">
        {error ? (
          <Aviso tono="danger" titulo={error.titulo} icono={<AlertTriangle strokeWidth={1.75} />}>
            {error.detalle}
          </Aviso>
        ) : null}
        <div className="cr-panel">
          <EstadoVacio
            title="Todavía no hay un catálogo cargado"
            detalle="Sube el Excel con las dos hojas: el catálogo de productos y el mapeo con los códigos de cada cadena."
          >
            <Package strokeWidth={1.25} size={28} style={{ color: "var(--cr-ink-3)" }} />
          </EstadoVacio>
          <div className="px-4 pb-4">
            <AnalisisUploader
              onArchivo={alArchivo}
              cargando={estado !== "inactivo"}
              nombreArchivo={null}
              nota="El archivo reemplaza por completo el catálogo actual."
            />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <BarraSegmentada
          opciones={VISTAS}
          valor={vista}
          etiqueta="Vistas del catálogo"
          onCambio={(v) => {
            setVista(v);
            setPagina(1);
          }}
        />
        <CargarCatalogo
          onArchivo={alArchivo}
          estado={estado}
          progreso={progreso}
          carga={carga}
        />
      </div>

      {error ? (
        <Aviso tono="danger" titulo={error.titulo} icono={<AlertTriangle strokeWidth={1.75} />}>
          {error.detalle}
        </Aviso>
      ) : null}

      {aviso ? (
        <Aviso tono="warn" titulo="Aviso">
          {aviso}
        </Aviso>
      ) : null}

      {carga && (carga.descartados.productos > 0 || avisosCarga.length > 0) ? (
        <Aviso tono="warn" titulo="La carga se hizo con avisos">
          {carga.descartados.productos > 0 ? (
            <p>
              {`Se cargaron ${carga.productos.toLocaleString("es-MX")} productos y se descartaron ${carga.descartados.productos.toLocaleString("es-MX")} filas por venir sin Item, Descripción, Estatus o Línea.`}
            </p>
          ) : null}
          {avisosCarga.slice(0, 5).map((i, n) => (
            <p key={`${i.field ?? i.row ?? n}`}>{i.message}</p>
          ))}
          {avisosCarga.length > 5 ? <p>{`Y ${avisosCarga.length - 5} avisos más.`}</p> : null}
        </Aviso>
      ) : null}

      {enCatalogo ? (
        <TablaCatalogo
          filas={productosVisibles}
          total={productosFiltrados.length}
          totalCarga={productos.length}
          pagina={paginaActual}
          paginas={paginas}
          busqueda={busqueda}
          onBusqueda={buscar}
          filtros={[
            {
              etiqueta: "Línea",
              valor: linea,
              opciones: resumen?.lineas ?? [],
              onCambio: (v) => {
                setLinea(v);
                setPagina(1);
              },
            },
            {
              etiqueta: "Estatus",
              valor: estatus,
              opciones: resumen?.estatus ?? [],
              onCambio: (v) => {
                setEstatus(v);
                setPagina(1);
              },
            },
          ]}
          onPagina={setPagina}
          onAbrir={setItemAbierto}
        />
      ) : (
        <TablaMapeo
          filas={mapeosVisibles}
          total={mapeosFiltrados.length}
          totalCarga={mapeos.length}
          huerfanos={carga?.huerfanos ?? 0}
          pagina={paginaActual}
          paginas={paginas}
          busqueda={busqueda}
          onBusqueda={buscar}
          filtros={[
            {
              etiqueta: "Canal",
              valor: canal,
              opciones: resumen?.canales ?? [],
              onCambio: (v) => {
                setCanal(v);
                setPagina(1);
              },
            },
          ]}
          onPagina={setPagina}
          onAbrir={setItemAbierto}
        />
      )}

      {itemAbierto ? (
        <FichaProducto item={itemAbierto} onCerrar={() => setItemAbierto(null)} />
      ) : null}
    </div>
  );
}
