// Plantillas de reportes conocidos.
//
// La inferencia genérica (inferir-tipos.ts) acierta en la mayoría de los casos,
// pero adivinar tiene límites: no sabe que "Item Nbr" es un código y no una
// cantidad, ni cuál de seis columnas numéricas es LA métrica del negocio. Para
// los reportes que llegan siempre igual se declara el layout aquí y los roles
// dejan de depender de heurísticas.
//
// Un archivo que no calce con ninguna plantilla sigue pasando por la
// inferencia, así que registrar una plantilla nunca cierra la puerta.

import { formatearFecha } from "./formato";
import {
  esDimensionable,
  esMetricable,
  valorFecha,
  valorNumerico,
} from "./inferir-tipos";
import type {
  AgregadoMetrica,
  CeldaCruda,
  Dataset,
  FilaCruda,
  MetaColumna,
} from "./tipos";

export type RolColumna =
  | "fecha" // el eje temporal del reporte
  | "dimension" // sirve para agrupar
  | "codigo" // identifica, no se suma
  | "metrica" // magnitud que se agrega
  | "ignorada"; // constante o sin información

/** En qué selector se ofrece la columna. */
export type FiltroColumna = "dimension" | "metrica";

export interface ColumnaPlantilla {
  /** Texto exacto del encabezado en el Excel. */
  header: string;
  /**
   * Nombre con el que se muestra en la app. El `header` viene en inglés de
   * Retail Link y sirve para RECONOCER el layout; esto es lo que lee el
   * cliente. Sin etiqueta se muestra el header tal cual.
   */
  etiqueta?: string;
  /** Nombre del campo al persistir en Mongo (inglés, como el resto de modelos). */
  campo: string;
  rol: RolColumna;
  /**
   * En qué desplegable se ofrece. Ausente = en ninguno: la columna se sigue
   * guardando y se sigue viendo en la tabla, pero no llena un filtro.
   *
   * Es una decisión de negocio y por eso se declara aquí en vez de deducirse
   * del tipo: el reporte de Walmart trae seis columnas numéricas y cuatro de
   * texto, y ofrecer las diez deja un menú que nadie sabe leer. Con esto el
   * cliente ve exactamente las cuatro dimensiones y las dos métricas que usa.
   */
  filtro?: FiltroColumna;
  /**
   * Tipo con el que viaja el valor al guardarlo. Se declara y no se infiere
   * porque el destino es un esquema fijo: `productCode` viene como número en
   * el Excel pero se guarda como texto, igual que `upc`, para que los códigos
   * se traten todos igual.
   */
  tipoDato: "date" | "number" | "string";
  /**
   * La columna es un importe en dinero. Se declara aquí y no se infiere porque
   * el dato no lo dice: "POS Qty" y "POS Sales" son las dos números y sólo la
   * segunda son pesos. Lo lee el formateo de celdas y el de las gráficas para
   * anteponer el "$".
   */
  moneda?: boolean;
  /**
   * Cómo se junta la columna al agrupar filas. Ausente = se suma, que es lo
   * correcto para unidades e importes. Se declara aquí por lo mismo que
   * `moneda`: el dato no dice si un número es aditivo, y sumar una columna que
   * ya viene promediada da un valor sin significado.
   */
  agregado?: AgregadoMetrica;
  /** Por qué se ignora; sólo para las de rol "ignorada". */
  motivo?: string;
}

/**
 * Cómo se arma la pestaña de productos de la ficha del retailer.
 *
 * Se declara aquí porque es una decisión de negocio y no algo deducible de los
 * tipos: `claves` dice qué identifica y describe a un producto —y por tanto
 * cuál es el GRANO de la tabla, una fila por combinación distinta— y `metricas`
 * qué columnas de números se muestran, que son menos que las que se guardan.
 */
export interface PlantillaProducto {
  /** Campos que identifican al producto; el primero encabeza la tabla. */
  claves: string[];
  /** Métricas que se muestran, en este orden. */
  metricas: string[];
}

export interface Plantilla {
  id: string;
  nombre: string;
  /** Cuenta a la que pertenece el reporte, como en el resto de retail. */
  account: string;
  columnas: ColumnaPlantilla[];
  /** Sin esto la ficha del retailer no arma su pestaña de productos. */
  producto?: PlantillaProducto;
}

/**
 * Reporte mensual de Walmart Retail Link.
 *
 * Trae 26 filas de preámbulo (título, "Report Options", "Selections Include",
 * la leyenda de Item Flags) antes del encabezado real, y el grano es
 * artículo × día: la clave (itemNbr, date) es única.
 *
 * Ojo con dos cosas del archivo real:
 * - `UPC` y `Vendor Nbr` traen ceros a la izquierda, así que son texto. Pasarlos
 *   por Number() perdería el cero y los volvería ilegibles.
 * - `WM Month` es el mes FISCAL de Walmart y no siempre coincide con el mes
 *   calendario de `Daily`, así que se guardan los dos.
 */
export const WALMART_MENSUAL: Plantilla = {
  id: "walmart-mensual",
  nombre: "Reporte mensual Walmart",
  account: "walmart",
  columnas: [
    {
      header: "Brand Desc",
      etiqueta: "Marca",
      campo: "brand",
      rol: "dimension",
      filtro: "dimension",
      tipoDato: "string",
    },
    {
      header: "Prime Item Nbr",
      etiqueta: "Código del producto",
      campo: "primeItemNbr",
      rol: "codigo",
      filtro: "dimension",
      tipoDato: "number",
    },
    {
      header: "Prime Item Desc",
      etiqueta: "Nombre del producto",
      campo: "itemDesc",
      rol: "dimension",
      filtro: "dimension",
      tipoDato: "string",
    },
    { header: "UPC", campo: "upc", rol: "codigo", filtro: "dimension", tipoDato: "string" },
    { header: "Product Code", campo: "productCode", rol: "codigo", tipoDato: "string" },
    {
      header: "Vendor Name",
      campo: "vendorName",
      rol: "ignorada",
      tipoDato: "string",
      motivo: "constante: siempre KPS COMERCIALIZADORA SA DE CV",
    },
    {
      header: "Vendor Nbr",
      campo: "vendorNbr",
      rol: "ignorada",
      tipoDato: "string",
      motivo: "constante: siempre 063617",
    },
    { header: "WM Month", campo: "wmMonth", rol: "dimension", tipoDato: "string" },
    {
      header: "POS Qty",
      etiqueta: "Unidades",
      campo: "posQty",
      rol: "metrica",
      filtro: "metrica",
      tipoDato: "number",
    },
    {
      // "POS Sales" es el importe vendido en punto de venta. El nombre en
      // inglés no se lee solo: el cliente pregunta por sus ventas, no por su
      // POS.
      header: "POS Sales",
      etiqueta: "Ventas netas",
      campo: "posSales",
      rol: "metrica",
      filtro: "metrica",
      tipoDato: "number",
      moneda: true,
    },
    {
      header: "Avg Price",
      etiqueta: "Precio promedio",
      campo: "avgPrice",
      rol: "metrica",
      tipoDato: "number",
      moneda: true,
      // En el archivo real Avg Price es EXACTAMENTE POS Sales / POS Qty fila a
      // fila (verificado al centésimo de millonésima), así que el precio
      // promedio de un producto es el cociente de los dos totales.
      agregado: { tipo: "razon", numerador: "posSales", divisor: "posQty" },
    },
    {
      header: "Avg Sales $ per Store",
      etiqueta: "Venta promedio por tienda",
      campo: "avgSalesPerStore",
      rol: "metrica",
      tipoDato: "number",
      moneda: true,
      // Aquí no hay identidad que invertir: el número de tiendas no viene en el
      // reporte y varía por día (de 1 a 287 en el archivo real), así que se
      // promedia sobre las filas. Sale a menos de 2% de la media ponderada por
      // tiendas, que costaría un acumulador derivado en el pipeline.
      agregado: { tipo: "promedio" },
    },
    { header: "Item Qty Sold", campo: "itemQtySold", rol: "metrica", tipoDato: "number" },
    { header: "# of Basket Occurences", campo: "basketOccurrences", rol: "metrica", tipoDato: "number" },
    {
      header: "Net Net Unit Margin%",
      campo: "netNetUnitMarginPct",
      rol: "ignorada",
      tipoDato: "number",
      motivo: "constante: 0 en todas las filas",
    },
    { header: "Daily", campo: "date", rol: "fecha", tipoDato: "date" },
    { header: "Item Nbr", campo: "itemNbr", rol: "codigo", tipoDato: "number" },
    { header: "Item Flags", campo: "itemFlags", rol: "ignorada", tipoDato: "string", motivo: "vacía" },
  ],
  // El grano es (nombre, UPC, marca) y no sólo el nombre: un "Prime Item Desc"
  // agrupa varios artículos, así que con la descripción sola habría que enseñar
  // UN upc de los varios que caen en la fila, que sería mentira.
  //
  // De las seis métricas guardadas se muestran tres: "Item Qty Sold" duplica a
  // "POS Qty", "# of Basket Occurences" es una medida de canasta que no dice
  // nada leída por artículo, y "Avg Sales $ per Store" es una lectura por
  // tienda que no cabe junto a los totales del producto. Las tres siguen
  // guardándose y se ven completas en /retail/analisis.
  producto: {
    claves: ["itemDesc", "upc", "brand"],
    metricas: ["posQty", "posSales", "avgPrice"],
  },
};

export const PLANTILLAS: Plantilla[] = [WALMART_MENSUAL];

export function plantillaPorId(id: string): Plantilla | null {
  return PLANTILLAS.find((p) => p.id === id) ?? null;
}

/**
 * Métrica que se muestra por omisión cuando se reconoce la plantilla, por
 * CAMPO y no por encabezado: el nombre visible es traducible y el campo no.
 */
const METRICA_PREFERIDA: Record<string, string> = {
  "walmart-mensual": "posSales",
};

function normalizar(header: string): string {
  return header.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Reconoce la plantilla de un dataset ya parseado.
 *
 * Basta con que estén TODAS las columnas que no se ignoran: así un reporte al
 * que Walmart le agregue una columna nueva se sigue reconociendo, y en cambio
 * uno al que le falte una métrica clave no se confunde con otro layout.
 */
export function reconocerPlantilla(columnas: MetaColumna[]): Plantilla | null {
  const presentes = new Set(columnas.map((c) => normalizar(c.nombre)));
  return (
    PLANTILLAS.find((p) =>
      p.columnas
        .filter((c) => c.rol !== "ignorada")
        .every((c) => presentes.has(normalizar(c.header)))
    ) ?? null
  );
}

export interface ColumnaResuelta extends MetaColumna {
  rol: RolColumna;
  campo: string;
  tipoDato: ColumnaPlantilla["tipoDato"];
  /** Cómo se junta al agrupar; "suma" cuando la plantilla no dice otra cosa. */
  agregado: AgregadoMetrica;
  /** En qué selector se ofrece; null = en ninguno. */
  filtro: FiltroColumna | null;
}

/**
 * Columnas que llenan un desplegable. Es la ÚNICA fuente de las opciones de
 * dimensión y de métrica cuando hay plantilla, y la usan por igual el cliente
 * (para pintar los selectores) y la ruta de resumen (para saber qué agrupar):
 * si las dos listas se separaran, elegir una dimensión sin acumuladores dejaría
 * la gráfica en blanco.
 */
export function opcionesDeFiltro(
  columnas: ColumnaResuelta[],
  filtro: FiltroColumna
): ColumnaResuelta[] {
  return columnas.filter((c) => c.filtro === filtro);
}

/**
 * Aplica los roles de la plantilla sobre las columnas inferidas. Lo que la
 * plantilla no menciona conserva lo que dijo la inferencia, así que una columna
 * nueva sigue siendo usable.
 */
export function aplicarPlantilla(
  columnas: MetaColumna[],
  plantilla: Plantilla
): ColumnaResuelta[] {
  const porHeader = new Map(plantilla.columnas.map((c) => [normalizar(c.header), c]));

  return columnas.map((col) => {
    const def = porHeader.get(normalizar(col.nombre));
    if (!def) {
      // Columna fuera de la plantilla: se deduce el rol de lo inferido.
      const rol: RolColumna =
        col.tipo === "vacia" || col.esConstante
          ? "ignorada"
          : col.tipo === "fecha"
            ? "fecha"
            : col.esIdentificador
              ? "codigo"
              : col.tipo === "numero"
                ? "metrica"
                : "dimension";
      const tipoDato =
        col.tipo === "fecha" ? "date" : col.tipo === "numero" ? "number" : "string";
      // Lo que la plantilla no menciona sigue siendo usable: una columna que
      // Walmart agregue mañana aparece en el filtro que le corresponda por su
      // tipo, en vez de quedar invisible hasta que alguien la declare.
      const filtro: FiltroColumna | null = esMetricable(col)
        ? "metrica"
        : esDimensionable(col)
          ? "dimension"
          : null;
      // Una columna que Walmart agregue mañana se suma: es lo que hace la
      // inferencia con cualquier número, y sin plantilla no hay de dónde saber
      // que ya viene promediada.
      return { ...col, rol, campo: col.nombre, tipoDato, filtro, agregado: { tipo: "suma" } };
    }

    return {
      ...col,
      // La etiqueta reemplaza al header en TODA la interfaz —filtros, tabla,
      // títulos de gráfica y KPIs— para que la misma columna se llame igual en
      // todas partes.
      nombre: def.etiqueta ?? col.nombre,
      rol: def.rol,
      campo: def.campo,
      tipoDato: def.tipoDato,
      filtro: def.filtro ?? null,
      // La plantilla manda: un código nunca se suma aunque venga como número, y
      // una columna ignorada queda fuera de todos los selectores.
      esIdentificador: def.rol === "codigo" || col.esIdentificador,
      esConstante: def.rol === "ignorada" ? true : col.esConstante,
      esMoneda: def.moneda ?? false,
      agregado: def.agregado ?? { tipo: "suma" },
    };
  });
}

/** Índice de la columna con ese rol, o -1. Para las selecciones por omisión. */
export function indicePorRol(columnas: ColumnaResuelta[], rol: RolColumna): number {
  return columnas.find((c) => c.rol === rol)?.indice ?? -1;
}

/**
 * Métrica por omisión de una plantilla: la preferida si está declarada, si no
 * la primera que se ofrece en el selector. La segunda alternativa es por rol y
 * no por filtro para que una plantilla que no declare `filtro` siga abriendo
 * con una métrica elegida.
 */
function indiceMetrica(columnas: ColumnaResuelta[], plantillaId: string): number {
  const preferida = METRICA_PREFERIDA[plantillaId];
  const metrica =
    (preferida ? columnas.find((c) => c.rol === "metrica" && c.campo === preferida) : undefined) ??
    columnas.find((c) => c.filtro === "metrica") ??
    columnas.find((c) => c.rol === "metrica");
  return metrica?.indice ?? -1;
}

/** Dimensión por omisión: la primera que se ofrece, si no la primera del rol. */
function indiceDimension(columnas: ColumnaResuelta[]): number {
  const dim =
    columnas.find((c) => c.filtro === "dimension") ??
    columnas.find((c) => c.rol === "dimension");
  return dim?.indice ?? -1;
}

/** Filtros iniciales: dimensión, métrica y fecha según los roles declarados. */
export interface SeleccionInicial {
  idxDimension: number;
  idxMetrica: number;
  idxFecha: number;
}

function seleccionar(columnas: ColumnaResuelta[], plantillaId: string): SeleccionInicial {
  return {
    idxDimension: indiceDimension(columnas),
    idxMetrica: indiceMetrica(columnas, plantillaId),
    idxFecha: indicePorRol(columnas, "fecha"),
  };
}

/**
 * Selección inicial de filtros para un dataset con plantilla reconocida.
 * Devuelve null si no calza ninguna, para que el llamador use la inferencia.
 */
export function seleccionDePlantilla(
  dataset: Dataset
): ({ plantilla: Plantilla; columnas: ColumnaResuelta[] } & SeleccionInicial) | null {
  const plantilla = reconocerPlantilla(dataset.columnas);
  if (!plantilla) return null;

  const columnas = aplicarPlantilla(dataset.columnas, plantilla);
  return { plantilla, columnas, ...seleccionar(columnas, plantilla.id) };
}

// ------------------------------------------------ del histórico al analizador

/**
 * Columnas cuando las filas vienen de Mongo y no de un Excel.
 *
 * El histórico guarda exactamente las columnas útiles de la plantilla, así que
 * no hay nada que inferir: los tipos y los roles ya están declarados arriba.
 * Se sintetiza una ColumnaResuelta por cada una — la MISMA forma que produce
 * `aplicarPlantilla` — para que la tabla, los filtros, las gráficas, el
 * formateo de celdas y el buscador sean el mismo código en los dos modos.
 */
export function columnasHistorico(plantilla: Plantilla): ColumnaResuelta[] {
  return plantilla.columnas
    .filter((c) => c.rol !== "ignorada")
    .map((c, i) => ({
      // El índice es la posición en ESTA lista, no en el Excel: las filas se
      // arman en el mismo orden justo abajo.
      indice: i,
      nombre: c.etiqueta ?? c.header,
      campo: c.campo,
      rol: c.rol,
      filtro: c.filtro ?? null,
      tipoDato: c.tipoDato,
      tipo:
        c.tipoDato === "date" ? "fecha" : c.tipoDato === "number" ? "numero" : "categoria",
      noVacias: 0,
      cardinalidad: 0,
      esIdentificador: c.rol === "codigo",
      esConstante: false,
      esMoneda: c.moneda ?? false,
      agregado: c.agregado ?? { tipo: "suma" as const },
      magnitud: 0,
      // Mongo devuelve números como números y fechas ya en ISO, así que no hay
      // separador decimal ni orden dd/mm que resolver.
      formatoNumerico: "nativo",
      ordenFecha: null,
    }));
}

/**
 * Columnas del histórico y su selección inicial, sin filas de por medio.
 *
 * La ruta de resumen la necesita para saber qué campo agrupar cuando el cliente
 * todavía no eligió nada: al entrar a la pestaña aún no sabe ni qué plantilla
 * tiene el último reporte. Comparte `seleccionar` con el camino del archivo
 * subido, así que los dos abren con la misma dimensión y la misma métrica.
 */
export function seleccionHistorico(
  plantilla: Plantilla
): { columnas: ColumnaResuelta[] } & SeleccionInicial {
  const columnas = columnasHistorico(plantilla);
  return { columnas, ...seleccionar(columnas, plantilla.id) };
}

/**
 * Reordena las filas del servidor al orden de columnas de la plantilla.
 *
 * `campos` dice en qué orden llegan los valores; se permutan en vez de confiar
 * en que las dos listas coincidan. Si el servidor agrega o reordena un campo,
 * aquí no se desalinean las columnas: las que falten quedan en null (-1 marca
 * la columna que el servidor no mandó).
 *
 * Se usa tanto al armar el dataset inicial como al cambiar de página de la
 * tabla, que trae filas nuevas para las mismas columnas.
 */
export function permutarFilas(
  columnas: ColumnaResuelta[],
  campos: string[],
  filas: CeldaCruda[][]
): FilaCruda[] {
  const posicion = new Map(campos.map((campo, i) => [campo, i]));
  const orden = columnas.map((c) => posicion.get(c.campo) ?? -1);
  return filas.map((fila) => orden.map((i) => (i < 0 ? null : (fila[i] ?? null))));
}

/**
 * Dataset a partir de lo que devuelve el endpoint del histórico.
 *
 * Recibe una PÁGINA de filas, no el reporte entero, y aun así describe bien las
 * columnas: `columnasHistorico` saca tipos y roles de la plantilla y no de los
 * datos. `totalFilas` cuenta sólo lo recibido; el total del reporte lo informa
 * el servidor aparte.
 */
export function datasetDesdeHistorico(
  plantilla: Plantilla,
  campos: string[],
  filas: CeldaCruda[][],
  nombre: string
): {
  dataset: Dataset;
  plantilla: Plantilla;
  columnas: ColumnaResuelta[];
} & SeleccionInicial {
  const { columnas, ...seleccion } = seleccionHistorico(plantilla);

  const dataset: Dataset = {
    hoja: nombre,
    // No hubo detección de encabezado: los nombres vienen declarados.
    filaEncabezado: -1,
    columnas,
    filas: permutarFilas(columnas, campos, filas),
    totalFilas: filas.length,
  };

  return { dataset, plantilla, columnas, ...seleccion };
}

/** Una fila lista para el histórico: campos de la plantilla → valor plano. */
export type FilaHistorico = Record<string, string | number>;

/**
 * Convierte las filas crudas a la forma que espera el endpoint del histórico.
 *
 * Se descarta la fila que no tenga fecha o código de artículo legibles: son las
 * dos partes de la clave natural (account, itemNbr, date), y sin ellas el
 * upsert no puede ser idempotente. Se informa cuántas se descartaron en vez de
 * hacerlo en silencio.
 */
export function filasParaHistorico(
  dataset: Dataset,
  columnas: ColumnaResuelta[]
): { filas: FilaHistorico[]; descartadas: number } {
  const utiles = columnas.filter((c) => c.rol !== "ignorada");
  const colFecha = utiles.find((c) => c.rol === "fecha");
  const colItem = utiles.find((c) => c.campo === "itemNbr");

  const filas: FilaHistorico[] = [];
  let descartadas = 0;

  for (const cruda of dataset.filas) {
    const fecha = colFecha ? valorFecha(cruda[colFecha.indice], colFecha) : null;
    const item = colItem ? valorNumerico(cruda[colItem.indice], colItem) : null;
    if (!fecha || item === null) {
      descartadas++;
      continue;
    }
    filas.push(mapearFila(cruda, utiles));
  }

  return { filas, descartadas };
}

function mapearFila(cruda: FilaCruda, columnas: ColumnaResuelta[]): FilaHistorico {
  const fila: FilaHistorico = {};
  for (const col of columnas) {
    const v = cruda[col.indice];
    if (col.tipoDato === "date") {
      const d = valorFecha(v, col);
      fila[col.campo] = d ? formatearFecha(d) : "";
    } else if (col.tipoDato === "number") {
      fila[col.campo] = valorNumerico(v, col) ?? 0;
    } else {
      // Los códigos numéricos se guardan como texto sin separadores, para que
      // "0750229353070" y 10283710 se traten igual aguas abajo.
      fila[col.campo] = v === null || v === undefined ? "" : String(v).trim();
    }
  }
  return fila;
}
