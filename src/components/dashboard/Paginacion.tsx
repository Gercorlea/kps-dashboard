"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";

/**
 * Pie de paginación de una lista. Es el mismo de Industria Real
 * (`components/ui/cr-pagination.tsx`): rango a la izquierda, chevrones y
 * "Página X de Y" a la derecha, con `.cr-page-btn`.
 *
 * POR QUE EL RANGO Y NO EL TOTAL A SECAS. "1.240 registros" no dice por dónde
 * vas; "Mostrando 21 - 40 de 1.240" sí, y es lo que deja saber cuánto falta sin
 * contar páginas.
 *
 * POR QUE LOS BOTONES SE DESHABILITAN EN VEZ DE DESAPARECER. Es lo que hace
 * Industria Real, y mantiene el ancho del bloque estable: si el botón se va, el
 * texto de en medio salta de sitio al llegar a la primera o a la última página.
 */
export function Paginacion({
  pagina,
  paginas,
  total,
  porPagina,
  onCambiar,
  sustantivo = "registros",
}: {
  pagina: number;
  paginas: number;
  total: number;
  porPagina: number;
  onCambiar: (p: number) => void;
  sustantivo?: string;
}) {
  if (total === 0) return null;

  const desde = (pagina - 1) * porPagina + 1;
  const hasta = Math.min(pagina * porPagina, total);

  return (
    // Pie DENTRO del mismo panel, separado por hairline: no es una caja aparte.
    // `data-paginacion` no es decorativo: es como `useFilasQueCaben` encuentra
    // este pie para medir su alto real en vez de estimarlo.
    <div
      data-paginacion
      className="flex items-center justify-between gap-3 border-t border-[color:var(--cr-line-soft)] px-4 py-3"
    >
      <span className="cr-small cr-ink-3">
        Mostrando {desde.toLocaleString("es-MX")} - {hasta.toLocaleString("es-MX")} de{" "}
        {total.toLocaleString("es-MX")} {sustantivo}
      </span>
      {paginas > 1 ? (
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="cr-page-btn"
            onClick={() => onCambiar(Math.max(1, pagina - 1))}
            disabled={pagina === 1}
            aria-label="Página anterior"
          >
            <ChevronLeft strokeWidth={1.75} />
          </button>
          <span className="cr-mono cr-ink-2 text-[12px]">
            Página {pagina} de {paginas}
          </span>
          <button
            type="button"
            className="cr-page-btn"
            onClick={() => onCambiar(Math.min(paginas, pagina + 1))}
            disabled={pagina === paginas}
            aria-label="Página siguiente"
          >
            <ChevronRight strokeWidth={1.75} />
          </button>
        </div>
      ) : null}
    </div>
  );
}
