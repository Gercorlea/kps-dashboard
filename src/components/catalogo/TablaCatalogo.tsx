"use client";

import { Paginacion } from "@/components/dashboard/Paginacion";
import { fmtFecha } from "@/components/lib/fmt";
import { BuscadorTabla, type FiltroSelect } from "@/components/catalogo/BuscadorTabla";
import { Badge } from "@/components/ui/basicos";
import { tonoEstatus } from "@/lib/catalogo/estatus";
import type { FilaCatalogo } from "@/lib/catalogo/tipos";

/*
 * Las siete columnas que se muestran; el resto está en la ficha.
 */
const COLUMNAS: { campo: keyof FilaCatalogo; etiqueta: string; mono?: boolean }[] = [
  { campo: "item", etiqueta: "Item", mono: true },
  { campo: "description", etiqueta: "Descripción" },
  { campo: "status", etiqueta: "Estatus" },
  { campo: "line", etiqueta: "Línea" },
  { campo: "upc", etiqueta: "UPC", mono: true },
  { campo: "salesUnit", etiqueta: "Unidad de venta" },
  { campo: "launchDate", etiqueta: "Fecha de lanzamiento", mono: true },
];

export const COLUMNAS_BUSCADAS = COLUMNAS.map((c) => c.etiqueta);

export function TablaCatalogo({
  filas,
  total,
  totalCarga,
  pagina,
  paginas,
  porPagina,
  busqueda,
  onBusqueda,
  filtros,
  onPagina,
  onAbrir,
}: {
  /** Ya filtradas y paginadas. */
  filas: FilaCatalogo[];
  /** Cuántas hay tras filtrar. */
  total: number;
  /** Cuántas tiene la carga completa, para poder decir "N de M". */
  totalCarga: number;
  pagina: number;
  paginas: number;
  porPagina: number;
  busqueda: string;
  onBusqueda: (v: string) => void;
  filtros: FiltroSelect[];
  onPagina: (p: number) => void;
  onAbrir: (item: string) => void;
}) {
  const filtrando = total !== totalCarga;

  return (
    <section className="cr-panel">
      <header className="cr-panel__head flex-wrap gap-3">
        <div className="flex flex-col gap-1">
          <h3 className="cr-h3">Catálogo de productos</h3>
          <span className="cr-small">
            {filtrando
              ? `${total.toLocaleString("es-MX")} de ${totalCarga.toLocaleString("es-MX")} productos`
              : `${totalCarga.toLocaleString("es-MX")} productos`}
          </span>
        </div>
        <BuscadorTabla
          busqueda={busqueda}
          onBusqueda={onBusqueda}
          placeholder="Buscar producto…"
          columnasBuscadas={COLUMNAS_BUSCADAS}
          filtros={filtros}
        />
      </header>

      <div className="cr-table-scroll">
        <table className="cr-table cr-table--head-lg">
          <thead>
            <tr>
              {COLUMNAS.map((c) => (
                <th key={c.campo} scope="col">
                  {c.etiqueta}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filas.length === 0 ? (
              <tr>
                <td colSpan={COLUMNAS.length} className="cr-body py-10 text-center">
                  {busqueda.trim()
                    ? `Ningún producto coincide con «${busqueda.trim()}».`
                    : "Sin productos que mostrar."}
                </td>
              </tr>
            ) : (
              filas.map((f) => (
                <tr
                  key={f.item}
                  className="cr-fila-link"
                  onClick={() => {
                    // Arrastrar para seleccionar texto termina en un click, y
                    // eso no es "abrir el producto".
                    if (window.getSelection()?.toString()) return;
                    onAbrir(f.item);
                  }}
                >
                  {COLUMNAS.map((c) => {
                    const valor =
                      c.campo === "launchDate"
                        ? f.launchDate
                          ? fmtFecha(f.launchDate)
                          : // Si la fecha no se pudo interpretar se muestra lo
                            // que traía el archivo, no un hueco.
                            f.launchDateText
                        : f[c.campo];
                    const texto = String(valor ?? "");

                    // El estatus va como badge de color: es lo que decide si el
                    // producto se puede pedir, y en una tabla de siete columnas
                    // de texto plano se perdía. El tono lo resuelve
                    // lib/catalogo/estatus.ts, que deja en neutro —visible, sin
                    // color— cualquier valor que no reconozca.
                    if (c.campo === "status") {
                      return (
                        <td key={c.campo}>
                          {texto ? (
                            <span title={texto}>
                              <Badge tono={tonoEstatus(texto)}>{texto}</Badge>
                            </span>
                          ) : (
                            "—"
                          )}
                        </td>
                      );
                    }

                    if (c.campo === "item") {
                      return (
                        <td key={c.campo} className="cr-mono">
                          {/* El botón no lleva onClick a propósito: activarlo
                              con Enter o Espacio dispara un click que sube al
                              <tr>, así que el teclado funciona y no hay doble
                              disparo. */}
                          <button
                            type="button"
                            className="cr-link block max-w-full cursor-pointer truncate text-left"
                            title={texto}
                          >
                            {texto || "—"}
                          </button>
                        </td>
                      );
                    }

                    return (
                      <td key={c.campo} className={c.mono ? "cr-mono" : undefined}>
                        <span className="block truncate" title={texto}>
                          {texto || "—"}
                        </span>
                      </td>
                    );
                  })}
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
        sustantivo="productos"
      />
    </section>
  );
}
