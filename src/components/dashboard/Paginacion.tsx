"use client";

/**
 * Pie de paginación de una tabla: cuántos registros hay y por dónde va.
 *
 * Los botones sólo existen cuando llevan a algún sitio: en la primera página no
 * hay "Anterior", en la última no hay "Siguiente" y con una sola página no hay
 * ninguno de los dos. Un botón deshabilitado invita a pulsarlo y no responde;
 * mejor que no esté. Por lo mismo, "página 1 de 1" no se dice: no informa de
 * nada y sugiere que hay más.
 */
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
  const hayAnterior = pagina > 1;
  const haySiguiente = pagina < paginas;

  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3">
      <span className="cr-small cr-mono">
        {total.toLocaleString("es-MX")} registros
        {paginas > 1 ? ` · página ${pagina} de ${paginas}` : ""}
      </span>
      {hayAnterior || haySiguiente ? (
        <div className="flex gap-1">
          {hayAnterior ? (
            <button
              type="button"
              className="cr-btn cr-btn--secondary cr-btn--sm"
              onClick={() => onCambiar(pagina - 1)}
            >
              Anterior
            </button>
          ) : null}
          {haySiguiente ? (
            <button
              type="button"
              className="cr-btn cr-btn--secondary cr-btn--sm"
              onClick={() => onCambiar(pagina + 1)}
            >
              Siguiente
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
