"use client";

import { Search } from "lucide-react";
import type { Faceta } from "@/lib/catalogo/tipos";

export interface FiltroSelect {
  /** Etiqueta del `select`, para el lector de pantalla. */
  etiqueta: string;
  valor: string;
  opciones: Faceta[];
  onCambio: (v: string) => void;
}

/**
 * Buscador de las tablas del catálogo, con sus filtros.
 *
 * Es el mismo control que la pestaña Productos de la ficha del retailer, y a
 * propósito: filtra en cada tecla, sin debounce y sin viaje al servidor. Las
 * filas ya están en el navegador (ver api/catalogo/productos), así que meter un
 * retardo aquí sólo se notaría como lentitud.
 *
 * El `title` dice en qué columnas busca: con el UPC y la línea a la vista,
 * teclear cualquiera de los dos y no encontrar nada sorprendería.
 */
export function BuscadorTabla({
  busqueda,
  onBusqueda,
  placeholder,
  columnasBuscadas,
  filtros = [],
}: {
  busqueda: string;
  onBusqueda: (v: string) => void;
  placeholder: string;
  columnasBuscadas: string[];
  filtros?: FiltroSelect[];
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {filtros.map((f) => (
        <label key={f.etiqueta} className="relative">
          <span className="sr-only">{f.etiqueta}</span>
          <select
            className="cr-input"
            style={{ width: "10rem" }}
            value={f.valor}
            onChange={(e) => f.onCambio(e.target.value)}
          >
            <option value="">{f.etiqueta}: todas</option>
            {f.opciones.map((o) => (
              <option key={o.id} value={o.id}>
                {o.etiqueta} ({o.filas})
              </option>
            ))}
          </select>
        </label>
      ))}

      <label className="relative">
        <span className="sr-only">{placeholder}</span>
        <Search
          size={13}
          strokeWidth={2}
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2"
          style={{ color: "var(--cr-ink-3)" }}
        />
        <input
          type="search"
          className="cr-input"
          style={{ paddingLeft: 28, width: "16rem" }}
          placeholder={placeholder}
          title={
            columnasBuscadas.length > 0 ? `Busca en: ${columnasBuscadas.join(", ")}` : undefined
          }
          value={busqueda}
          onChange={(e) => onBusqueda(e.target.value)}
        />
      </label>
    </div>
  );
}
