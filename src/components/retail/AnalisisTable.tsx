import { memo, useMemo } from "react";
import { Search } from "lucide-react";
import { Paginacion } from "@/components/dashboard/Paginacion";
import { formatearCeldaNormalizada, formatearEntero } from "@/lib/retail/analisis/formato";
import type { FilaCruda, MetaColumna } from "@/lib/retail/analisis/tipos";

// Un archivo muy ancho no aporta nada tras las primeras decenas de columnas y
// multiplica el DOM: se recorta y se avisa.
export const MAX_COLUMNAS = 60;

// Dos densidades, porque son dos tablas distintas con el mismo componente.
//
// `densa` es el volcado crudo de un Excel: 14 columnas que con los valores del
// design system —pensados para 6-8— no entran en pantalla. Se aprieta el
// padding y la letra, y el encabezado fluye en varias líneas porque con nowrap
// "Avg Sales $ per Store" fijaba el ancho de toda su columna.
//
// La normal es el catálogo de productos: seis columnas y el padding del design
// system. Si se aprieta, la letra y los espacios dejan de concordar con el
// resto del módulo.
//
// En la densa, el encabezado y la celda comparten tope de ancho: con dos topes
// distintos el navegador negociaba el ancho de cada columna por su cuenta y las
// separaciones salían desparejas de una columna a otra.
const ANCHO_DENSA = "7rem";

/**
 * Suelo de ancho por columna, y a partir de cuántas columnas se aplica.
 *
 * Con `width: 100%` y layout automático el navegador mete como sea todas las
 * columnas en el panel: con veinte o más las aplasta hasta su contenido mínimo
 * y quedan tiras de dos caracteres con puntos suspensivos. Con un suelo la
 * tabla ya no cabe, se desborda dentro de `.cr-table-scroll` y sale la barra
 * horizontal — que es lo que se quiere: se lee moviéndose a la derecha, no
 * entrecerrando los ojos.
 *
 * El umbral existe para no tocar el caso afinado: el reporte de Walmart son
 * catorce columnas que entran justas y sin barra, y un suelo aplicado siempre
 * se la sacaría en pantallas de 1280.
 */
const MINIMO_DENSA = "4.5rem";
const COLUMNAS_APRETADAS = 20;

const ENCABEZADO_DENSA: React.CSSProperties = {
  padding: "5px 7px",
  maxWidth: ANCHO_DENSA,
  whiteSpace: "normal",
  lineHeight: 1.25,
  verticalAlign: "bottom",
};

const CELDA_DENSA: React.CSSProperties = {
  padding: "4px 7px",
  fontSize: "11px",
  maxWidth: ANCHO_DENSA,
  whiteSpace: "nowrap",
};

// El padding lo pone el design system; el tamaño no, porque sus 9px son
// ilegibles en una tabla de pocas columnas. Aquí van a 11px —el mismo que
// `.cr-table--head-lg`, así que las tres tablas del módulo leen igual— para
// que el nombre de la columna se lea de un vistazo, y con el tracking
// recortado: el .08em del design system está calibrado para 9px y a este
// tamaño estira los encabezados a lo ancho sin necesidad.
// Se parte en varias líneas: con el ancho ya repartido, un encabezado largo no
// puede ensanchar su columna, así que en una ventana angosta o baja de renglón
// o se derrama sobre la de al lado. Alineados abajo, la fila queda pareja
// aunque unos ocupen dos líneas y otros una.
const ENCABEZADO_NORMAL: React.CSSProperties = {
  fontSize: "11px",
  letterSpacing: ".05em",
  whiteSpace: "normal",
  lineHeight: 1.3,
  verticalAlign: "bottom",
};

// El recorte lo hace el <span> de dentro, que es el que lleva la elipsis.
const CELDA_NORMAL: React.CSSProperties = { whiteSpace: "nowrap" };

const TABLA_NORMAL: React.CSSProperties = { tableLayout: "fixed" };

/** Ninguna columna baja de esto, para que "UPC" no salga en un hilo. */
const MINIMO = 8;
/** Ni pasa de esto: un nombre larguísimo si no se comía el ancho de las demás. */
const MAXIMO = 26;

/**
 * Anchos en porcentaje, proporcionales a lo que cada columna tiene que mostrar.
 *
 * El catálogo son seis columnas cortas en un panel muy ancho: sobran cientos de
 * pixeles y hay que meterlos en algún lado. Dárselos a una sola la deja enorme;
 * dejarlos al final deja media tabla vacía; repartirlos a partes iguales ignora
 * que "Marca" necesita nueve caracteres y "Ventas netas" catorce, y abre un
 * hueco enorme justo entre las dos. Repartirlos en proporción reparte también
 * el sobrante: cada columna queda holgada en la misma medida y la tabla llega
 * al borde derecho.
 *
 * La medida es en caracteres —del encabezado o del dato más largo de la página,
 * el que mande— y no en pixeles: no hay forma de medir texto sin renderizarlo,
 * y para repartir un porcentaje basta con la proporción.
 */
function anchosProporcionales(
  columnas: MetaColumna[],
  filas: FilaCruda[]
): string[] {
  const largos = columnas.map((col) => {
    // El encabezado va en versalitas mono con tracking, así que ocupa más por
    // carácter que el dato aunque ahora midan los mismos 13px; el 1.2 lo
    // compensa a ojo.
    let largo = col.nombre.length * 1.2;
    for (const fila of filas) {
      largo = Math.max(largo, formatearCeldaNormalizada(fila[col.indice], col).length);
    }
    return Math.min(MAXIMO, Math.max(MINIMO, largo));
  });

  const total = largos.reduce((a, b) => a + b, 0);
  return largos.map((l) => `${((l / total) * 100).toFixed(3)}%`);
}

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
  /** Volcado crudo de un Excel: muchas columnas y todo más apretado. */
  densa?: boolean;
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
  densa = false,
}: Props) {
  const visibles = columnas.slice(0, MAX_COLUMNAS);
  // El suelo de ancho sólo entra con muchas columnas; ver MINIMO_DENSA.
  const suelo = densa && visibles.length >= COLUMNAS_APRETADAS ? MINIMO_DENSA : undefined;
  const encabezado = densa
    ? { ...ENCABEZADO_DENSA, minWidth: suelo }
    : ENCABEZADO_NORMAL;
  const celda = densa ? { ...CELDA_DENSA, minWidth: suelo } : CELDA_NORMAL;
  // La densa no reparte nada: catorce columnas ya llenan el panel de sobra y
  // ahí el ancho lo tiene que marcar el contenido.
  const anchos = useMemo(
    () => (densa ? null : anchosProporcionales(columnas.slice(0, MAX_COLUMNAS), filasVisibles)),
    [densa, columnas, filasVisibles]
  );
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
        <table className="cr-table" style={densa ? undefined : TABLA_NORMAL}>
          <thead>
            <tr>
              {visibles.map((col, i) => (
                <th
                  key={col.indice}
                  scope="col"
                  className={col.tipo === "numero" && !col.esIdentificador ? "num" : undefined}
                  style={{ ...encabezado, width: anchos?.[i] }}
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
                      <td key={col.indice} className={clases} title={texto} style={celda}>
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
