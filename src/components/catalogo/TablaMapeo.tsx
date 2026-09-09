"use client";

import { Paginacion } from "@/components/dashboard/Paginacion";
import { BuscadorTabla, type FiltroSelect } from "@/components/catalogo/BuscadorTabla";
import { Badge } from "@/components/ui/basicos";
import type { FilaMapeo } from "@/lib/catalogo/tipos";

const COLUMNAS_BUSCADAS = ["SKU", "Canal", "Código cliente", "Descripción"];

export function TablaMapeo({
  filas,
  total,
  totalCarga,
  huerfanos,
  pagina,
  paginas,
  porPagina,
  busqueda,
  onBusqueda,
  filtros,
  onPagina,
  onAbrir,
}: {
  filas: FilaMapeo[];
  total: number;
  totalCarga: number;
  huerfanos: number;
  pagina: number;
  paginas: number;
  porPagina: number;
  busqueda: string;
  onBusqueda: (v: string) => void;
  filtros: FiltroSelect[];
  onPagina: (p: number) => void;
  /** Sólo se llama con un sku que sí está en el catálogo. */
  onAbrir: (sku: string) => void;
}) {
  const filtrando = total !== totalCarga;

  return (
    <section className="cr-panel">
      <header className="cr-panel__head flex-wrap gap-3">
        <div className="flex flex-col gap-1">
          <h3 className="cr-h3">Mapeo de productos</h3>
          <span className="cr-small">
            {filtrando
              ? `${total.toLocaleString("es-MX")} de ${totalCarga.toLocaleString("es-MX")} códigos`
              : `${totalCarga.toLocaleString("es-MX")} códigos`}
            {huerfanos > 0
              ? ` · ${huerfanos.toLocaleString("es-MX")} sin producto en el catálogo`
              : ""}
          </span>
        </div>
        <BuscadorTabla
          busqueda={busqueda}
          onBusqueda={onBusqueda}
          placeholder="Buscar mapeo…"
          columnasBuscadas={COLUMNAS_BUSCADAS}
          filtros={filtros}
        />
      </header>

      <div className="cr-table-scroll">
        <table className="cr-table cr-table--head-lg">
          <thead>
            <tr>
              <th scope="col">SKU</th>
              <th scope="col">Canal</th>
              <th scope="col">Código cliente</th>
              <th scope="col">Descripción</th>
            </tr>
          </thead>
          <tbody>
            {filas.length === 0 ? (
              <tr>
                <td colSpan={4} className="cr-body py-10 text-center">
                  {busqueda.trim()
                    ? `Ningún código coincide con «${busqueda.trim()}».`
                    : "El archivo no trae mapeo de productos."}
                </td>
              </tr>
            ) : (
              filas.map((f) => (
                <tr
                  key={`${f.sku}|${f.channel}`}
                  // Sólo es pulsable si el producto existe: abrir la ficha de un
                  // sku que no está en el catálogo daría un 404.
                  className={f.enCatalogo ? "cr-fila-link" : undefined}
                  onClick={
                    f.enCatalogo
                      ? () => {
                          if (window.getSelection()?.toString()) return;
                          onAbrir(f.sku);
                        }
                      : undefined
                  }
                >
                  <td className="cr-mono">
                    {f.enCatalogo ? (
                      <button
                        type="button"
                        className="cr-link block max-w-full cursor-pointer truncate text-left"
                        title={f.sku}
                      >
                        {f.sku}
                      </button>
                    ) : (
                      <span
                        className="block truncate"
                        title={`${f.sku} — este SKU no está en el catálogo cargado`}
                      >
                        {f.sku}
                      </span>
                    )}
                  </td>
                  <td>
                    {f.knownRetailer ? (
                      <Badge>{f.channelName || f.channel}</Badge>
                    ) : (
                      // Un canal que no es de los cuatro retailers del módulo:
                      // se guarda y se muestra, pero no cruza con ventas.
                      <Badge tono="warn">{f.channelName || f.channel}</Badge>
                    )}
                  </td>
                  <td className="cr-mono">
                    <span className="block truncate" title={f.customerCode}>
                      {f.customerCode || "—"}
                    </span>
                  </td>
                  <td>
                    <span className="block truncate" title={f.description}>
                      {f.description || "—"}
                      {!f.enCatalogo ? (
                        <span className="cr-small"> · sin producto en el catálogo</span>
                      ) : null}
                    </span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <Paginacion
        pagina={pagina}
        paginas={paginas}
        total={total}
        porPagina={porPagina}
        onCambiar={onPagina}
        sustantivo="códigos"
      />
    </section>
  );
}
