"use client";

// Tabla del último Excel guardado en el histórico. Es lo que se ve al entrar a
// /retail/analisis, sin tener que volver a subir el archivo.
//
// A diferencia del modo archivo, aquí las filas NO viven en memoria: se paginan
// y se buscan en Mongo. Bajar las 15 mil filas del reporte en cada navegación
// serían varios MB, y para analizarlo completo ya está el botón de subirlo.

import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ClientApiError } from "@/components/lib/api-client";
import { useDiferido } from "@/components/lib/useDiferido";
import { AnalisisTable } from "@/components/retail/AnalisisTable";
import { EstadoVacio, Panel } from "@/components/ui/basicos";
import { columnasBuscables } from "@/lib/retail/analisis/inferir-tipos";
import {
  columnasHistorico,
  filaCrudaDesdeHistorico,
  plantillaPorId,
} from "@/lib/retail/analisis/plantillas";

const POR_PAGINA = 100;

interface ArchivoHistorico {
  sourceFile: string;
  template: string;
  account: string;
  importedAt: string | null;
  total: number;
}

interface Respuesta {
  archivo: ArchivoHistorico | null;
  filas: Record<string, unknown>[];
  total: number;
  pagina: number;
  paginas: number;
}

function fechaHora(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? null
    : d.toLocaleString("es-MX", { dateStyle: "medium", timeStyle: "short" });
}

export function AnalisisHistorico() {
  const [busqueda, setBusqueda] = useState("");
  const buscar = useDiferido(busqueda);
  const [pagina, setPagina] = useState(1);
  const [datos, setDatos] = useState<Respuesta | null>(null);
  // El término que produjo las filas que se están viendo. Va detrás de
  // `busqueda` mientras la petición viaja, y es el que debe leer la leyenda.
  const [aplicada, setAplicada] = useState("");
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Al cambiar la búsqueda el total se encoge y la página actual puede quedar
  // fuera de rango; volver a la primera es lo único que siempre tiene sentido.
  const alBuscar = useCallback((valor: string) => {
    setBusqueda(valor);
    setPagina(1);
  }, []);

  const cargar = useCallback(async () => {
    setCargando(true);
    setError(null);
    try {
      const q = new URLSearchParams({ page: String(pagina), limit: String(POR_PAGINA) });
      if (buscar.trim()) q.set("buscar", buscar.trim());
      setDatos(await api<Respuesta>(`/api/retail/analisis/filas?${q.toString()}`));
      setAplicada(buscar.trim());
    } catch (e) {
      setError(
        e instanceof ClientApiError
          ? `No se pudo cargar el histórico: ${e.message}`
          : "No se pudo cargar el histórico."
      );
    } finally {
      setCargando(false);
    }
  }, [pagina, buscar]);

  useEffect(() => {
    // fetch-on-mount: el flag de carga se activa al iniciar la petición
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void cargar();
  }, [cargar]);

  const archivo = datos?.archivo ?? null;
  const crudas = datos?.filas;

  // Las columnas salen de la plantilla, no de una inferencia: el histórico
  // guarda exactamente los campos que ella declara, así que la tabla del
  // archivo y la del histórico muestran lo mismo, en el mismo orden.
  const columnas = useMemo(() => {
    const p = archivo ? plantillaPorId(archivo.template) : null;
    return p ? columnasHistorico(p) : [];
  }, [archivo]);

  const filas = useMemo(
    () => (crudas ?? []).map((d) => filaCrudaDesdeHistorico(d, columnas)),
    [crudas, columnas]
  );

  const buscables = useMemo(() => columnasBuscables(columnas), [columnas]);

  if (error) {
    return (
      <p className="cr-small" style={{ color: "var(--cr-danger)" }} role="alert">
        {error}
      </p>
    );
  }

  if (cargando && !datos) {
    return <div className="cr-panel cr-pulse" style={{ height: 280 }} aria-hidden="true" />;
  }

  // Sin nada guardado la pestaña se comporta como antes: invita a subir un
  // archivo. El histórico sólo aparece cuando hay algo que enseñar.
  if (!datos || !archivo) {
    return (
      <Panel>
        <EstadoVacio
          title="Sin archivo cargado"
          detalle="Sube un .xlsx para ver los datos y su análisis. Se detectan solas las columnas de fecha, numéricas y de categoría. Al guardarlo en el histórico volverá a aparecer aquí la próxima vez que entres."
        />
      </Panel>
    );
  }

  // Un archivo guardado con una plantilla que ya no existe en el código: se
  // dice, en vez de pintar una tabla sin columnas.
  if (columnas.length === 0) {
    return (
      <Panel>
        <EstadoVacio
          title="Reporte no reconocido"
          detalle={`El último reporte guardado («${archivo.sourceFile}») usa la plantilla «${archivo.template}», que ya no está registrada. Sube el archivo para analizarlo.`}
        />
      </Panel>
    );
  }

  const importado = fechaHora(archivo.importedAt);

  return (
    <AnalisisTable
      titulo="Último reporte guardado"
      columnas={columnas}
      filasVisibles={filas}
      totalFilas={archivo.total}
      totalFiltradas={datos.total}
      totalColumnas={columnas.length}
      detalles={[
        `archivo «${archivo.sourceFile}»`,
        ...(importado ? [`importado el ${importado}`] : []),
      ]}
      busqueda={busqueda}
      busquedaAplicada={aplicada}
      onBusqueda={alBuscar}
      columnasBuscadas={buscables.map((c) => c.nombre)}
      pagina={datos.pagina}
      paginas={datos.paginas}
      porPagina={POR_PAGINA}
      onPagina={setPagina}
      cargando={cargando}
    />
  );
}
