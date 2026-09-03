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
// La normal es el catálogo de productos: siete columnas y el padding del design
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
 * Ancho aproximado de un carácter, en px.
 *
 * El dato va a 13px y el encabezado en mono a 11 con tracking: los dos rondan
 * los 7px por carácter, así que una sola constante mide las dos cosas. Es una
 * estimación a propósito —medir texto de verdad obliga a renderizarlo y a un
 * ResizeObserver— y por eso las celdas recortan con elipsis: si una fila se
 * pasa de lo estimado se corta, en vez de descuadrar la tabla.
 */
const PX_POR_CARACTER = 7.2;

/** El padding lateral del design system (14px por lado), los dos juntos. */
const PADDING_CELDA = 28;

/**
 * Lo que pide el encabezado, medido en caracteres.
 *
 * No es su largo entero: se parte en varias líneas (ver `ENCABEZADO_NORMAL`),
 * así que "Código del producto" no necesita diecinueve caracteres de ancho
 * sino la mitad en dos renglones —o su palabra más larga, que es lo único que
 * no puede quebrarse—. Medirlo entero le daba a esa columna casi tanto sitio
 * como al nombre del producto para enseñar nueve dígitos, y dejaba el hueco
 * justo donde más falta hace el nombre.
 */
function anchoEncabezado(nombre: string): number {
  const palabras = nombre.split(/\s+/);
  const masLarga = palabras.reduce((max, p) => Math.max(max, p.length), 0);
  return Math.max(masLarga, nombre.length / 2);
}

/** Si la columna alinea su contenido a la derecha: las de números y nada más. */
function alineadaDerecha(col: MetaColumna): boolean {
  return col.tipo === "numero" && !col.esIdentificador;
}

/**
 * Cuántos huecos paga cada columna.
 *
 * El sobrante de una columna NO se ve donde está, sino del lado por el que su
 * contenido no llega al borde: una columna alineada a la izquierda lo deja a la
 * derecha de su texto y una de números lo deja a la izquierda de su cifra. Por
 * eso repartirlo a partes iguales por columna no empareja los huecos: justo
 * entre "Marca" y "Unidades" —la última de texto y la primera de números— se
 * juntaban los dos sobrantes y ese hueco salía del doble que los demás.
 *
 * Lo que se reparte a partes iguales es EL HUECO, entonces, y no la columna:
 * cada uno de los n-1 huecos de la fila se lo carga la columna que tiene el
 * espacio libre de ese lado —la de la izquierda si alinea a la izquierda, la de
 * la derecha si alinea a la derecha—, así que ninguno paga dos veces y ninguno
 * queda sin pagar. La primera columna nunca paga por su izquierda y la última
 * nunca por su derecha: el texto arranca pegado al borde y la última cifra
 * termina pegada al otro, que es como se espera que cierre una tabla.
 */
export function huecosPorColumna(derecha: boolean[]): number[] {
  const huecos = derecha.map(() => 0);
  for (let i = 0; i + 1 < derecha.length; i++) {
    huecos[derecha[i] ? i + 1 : i]++;
  }
  return huecos;
}

/**
 * Ancho de cada columna: lo que ocupa su contenido MÁS los huecos que le tocan.
 *
 * El catálogo son siete columnas cortas en un panel muy ancho: sobran cientos
 * de pixeles y hay que meterlos en algún lado. Repartirlos en proporción al
 * contenido le da los pixeles gordos a la columna que ya era la más ancha y
 * cada separación acaba de un tamaño distinto; repartirlos por columna deja el
 * hueco doble en la frontera entre el texto y los números (ver
 * `huecosPorColumna`). Repartirlos por hueco deja los n-1 iguales, que es lo
 * que se ve como una tabla pareja.
 *
 * El reparto lo hace el navegador y no este código: el sobrante depende del
 * ancho del panel, que aquí no se conoce, y `calc()` con el 100% de la tabla lo
 * resuelve a cualquier tamaño de ventana sin volver a medir nada. Los pixeles
 * de contenido salen de una estimación por carácter (ver `PX_POR_CARACTER`) y
 * el `minimo` es su suma: por debajo de eso ya no hay sobrante que repartir y
 * la tabla se desborda dentro de `.cr-table-scroll`, que es preferible a
 * aplastar siete columnas hasta la ilegibilidad.
 */
export function anchosUniformes(
  columnas: MetaColumna[],
  filas: FilaCruda[]
): { anchos: string[]; minimo: number } {
  const contenidos = columnas.map((col) => {
    let largo = anchoEncabezado(col.nombre);
    for (const fila of filas) {
      largo = Math.max(largo, formatearCeldaNormalizada(fila[col.indice], col).length);
    }
    const acotado = Math.min(MAXIMO, Math.max(MINIMO, largo));
    return Math.round(acotado * PX_POR_CARACTER) + PADDING_CELDA;
  });

  const minimo = contenidos.reduce((a, b) => a + b, 0);
  const huecos = huecosPorColumna(columnas.map(alineadaDerecha));
  // Con una sola columna no hay huecos que repartir y el divisor sería cero.
  const total = Math.max(1, columnas.length - 1);
  const sobrante = `(100% - ${minimo}px) / ${total}`;

  return {
    anchos: contenidos.map((px, i) =>
      huecos[i] === 0
        ? `${px}px`
        : `calc(${px}px + ${huecos[i] === 1 ? "" : `${huecos[i]} * `}${sobrante})`
    ),
    minimo,
  };
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
  const reparto = useMemo(
    () => (densa ? null : anchosUniformes(columnas.slice(0, MAX_COLUMNAS), filasVisibles)),
    [densa, columnas, filasVisibles]
  );
  const anchos = reparto?.anchos;
  // Sin este suelo el sobrante se vuelve negativo en una ventana angosta y las
  // siete columnas se aplastan a la vez; con él la tabla se desborda dentro de
  // su contenedor con scroll y se lee moviéndose a la derecha.
  const tabla = reparto
    ? { ...TABLA_NORMAL, minWidth: reparto.minimo }
    : undefined;
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
        <table className="cr-table" style={tabla}>
          <thead>
            <tr>
              {visibles.map((col, i) => (
                <th
                  key={col.indice}
                  scope="col"
                  className={alineadaDerecha(col) ? "num" : undefined}
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
                    const clases = alineadaDerecha(col)
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
