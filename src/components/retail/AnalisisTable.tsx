import { memo } from "react";
import { Search } from "lucide-react";
import { Paginacion } from "@/components/dashboard/Paginacion";
import { formatearCeldaNormalizada, formatearEntero } from "@/lib/retail/analisis/formato";
import type { FilaCruda, MetaColumna } from "@/lib/retail/analisis/tipos";

// Un archivo muy ancho no aporta nada tras las primeras decenas de columnas y
// multiplica el DOM: se recorta y se avisa.
export const MAX_COLUMNAS = 60;

// La tabla va más compacta que el resto del módulo: el design system está
// pensado para tablas de 6-8 columnas y aquí hay 14, que con los valores por
// omisión no entran en pantalla.
//
// El encabezado es lo que más ancho pedía: con nowrap, "Avg Sales $ per Store"
// fijaba el ancho de toda su columna. Dejándolo fluir en varias líneas el ancho
// lo marcan los datos, que son cortos.
const ENCABEZADO: React.CSSProperties = {
  padding: "5px 7px",
  maxWidth: "6rem",
  whiteSpace: "normal",
  lineHeight: 1.25,
  verticalAlign: "bottom",
};

const CELDA: React.CSSProperties = {
  padding: "4px 7px",
  fontSize: "11px",
  maxWidth: "7.5rem",
  whiteSpace: "nowrap",
};

interface Props {
  columnas: MetaColumna[];
  /** Sólo las filas de la página actual, ya paginadas por el llamador. */
  filasVisibles: FilaCruda[];
  /** Filas del archivo completo, antes de buscar. */
  totalFilas: number;
  /** Filas que coinciden con la búsqueda; igual a totalFilas si no hay. */
  totalFiltradas: number;
  totalColumnas: number;
  titulo?: string;
  /** Datos de procedencia para la leyenda (hoja, fila de encabezado…). */
  detalles?: string[];
  /** Lo que hay escrito en la caja. */
  busqueda: string;
  /**
   * La búsqueda que corresponde a las filas EN PANTALLA. En el histórico llega
   * con la respuesta del servidor, así que va un instante detrás de lo tecleado:
   * la leyenda tiene que hablar de lo que se está viendo, no de lo que se acaba
   * de escribir.
   */
  busquedaAplicada: string;
  onBusqueda: (valor: string) => void;
  /** Nombres de las columnas donde busca; se muestran para no hacer magia. */
  columnasBuscadas: string[];
  pagina: number;
  paginas: number;
  porPagina: number;
  onPagina: (pagina: number) => void;
  cargando?: boolean;
}

function AnalisisTableBase({
  columnas,
  filasVisibles,
  totalFilas,
  totalFiltradas,
  totalColumnas,
  titulo = "Datos",
  detalles = [],
  busqueda,
  busquedaAplicada,
  onBusqueda,
  columnasBuscadas,
  pagina,
  paginas,
  porPagina,
  onPagina,
  cargando = false,
}: Props) {
  const visibles = columnas.slice(0, MAX_COLUMNAS);
  const omitidas = totalColumnas - visibles.length;
  const termino = busquedaAplicada.trim();
  const buscando = termino !== "";

  // Con paginación la leyenda ya no dice "100 de 15,344": dice QUÉ 100. El
  // rango se calcula de la página, no de un contador acumulado, para que sea
  // correcto igual si las filas vienen de memoria o del servidor.
  const desde = totalFiltradas === 0 ? 0 : (pagina - 1) * porPagina + 1;
  const hasta = (pagina - 1) * porPagina + filasVisibles.length;
  const rango = `Filas ${formatearEntero(desde)}–${formatearEntero(hasta)}`;

  const leyenda = [
    totalFiltradas === 0
      ? buscando
        ? "Ninguna fila coincide"
        : "Sin filas"
      : buscando
        ? // Se dicen los dos números: cuántas coinciden y sobre cuántas, para
          // que no parezca que el reporte encogió.
          `${rango} de ${formatearEntero(totalFiltradas)} coincidencias · ${formatearEntero(totalFilas)} en el archivo`
        : `${rango} de ${formatearEntero(totalFilas)}`,
    ...detalles,
    omitidas > 0
      ? `${formatearEntero(omitidas)} columnas omitidas por constantes o vacías`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <section className="cr-panel">
      <header className="cr-panel__head flex-wrap gap-3">
        <div className="flex flex-col gap-1">
          <h3 className="cr-h3">{titulo}</h3>
          <span className="cr-small">{leyenda}</span>
        </div>

        <label className="relative">
          <span className="sr-only">Buscar producto</span>
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
            placeholder="Buscar producto…"
            title={
              columnasBuscadas.length > 0
                ? `Busca en: ${columnasBuscadas.join(", ")}`
                : undefined
            }
            value={busqueda}
            onChange={(e) => onBusqueda(e.target.value)}
          />
        </label>
      </header>

      <div className="cr-table-scroll" style={{ maxHeight: "22rem", overflowY: "auto" }}>
        <table className="cr-table">
          <thead>
            <tr>
              {visibles.map((col) => (
                <th
                  key={col.indice}
                  scope="col"
                  className={col.tipo === "numero" && !col.esIdentificador ? "num" : undefined}
                  style={ENCABEZADO}
                  title={col.nombre}
                >
                  {col.nombre}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filasVisibles.length === 0 ? (
              <tr>
                <td colSpan={Math.max(1, visibles.length)} className="cr-body py-10 text-center">
                  {cargando
                    ? "Cargando…"
                    : buscando
                      ? `Ningún producto coincide con «${termino}».`
                      : "Sin filas para mostrar."}
                </td>
              </tr>
            ) : (
              filasVisibles.map((fila, i) => (
                <tr key={i}>
                  {visibles.map((col) => {
                    const texto = formatearCeldaNormalizada(fila[col.indice], col);
                    const clases =
                      col.tipo === "numero" && !col.esIdentificador
                        ? "num"
                        : col.tipo === "fecha" || col.esIdentificador
                          ? "cr-mono"
                          : undefined;
                    return (
                      <td key={col.indice} className={clases} title={texto} style={CELDA}>
                        <span className="block truncate">{texto || "—"}</span>
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
        total={totalFiltradas}
        onCambiar={onPagina}
      />
    </section>
  );
}

// Cambiar un selector de gráficas no debe rerenderizar la tabla.
export const AnalisisTable = memo(AnalisisTableBase);
