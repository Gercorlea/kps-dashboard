"use client";

export function Paginacion({
  pagina,
  paginas,
  total,
  onCambiar,
}: {
  pagina: number;
  paginas: number;
  total: number;
  onCambiar: (p: number) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3">
      <span className="cr-small cr-mono">
        {total.toLocaleString("es-MX")} registros · página {pagina} de {paginas}
      </span>
      <div className="flex gap-1">
        <button
          type="button"
          className="cr-btn cr-btn--secondary cr-btn--sm"
          disabled={pagina <= 1}
          onClick={() => onCambiar(pagina - 1)}
        >
          Anterior
        </button>
        <button
          type="button"
          className="cr-btn cr-btn--secondary cr-btn--sm"
          disabled={pagina >= paginas}
          onClick={() => onCambiar(pagina + 1)}
        >
          Siguiente
        </button>
      </div>
    </div>
  );
}
