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
import { valorFecha, valorNumerico } from "./inferir-tipos";
import type { CeldaCruda, Dataset, FilaCruda, MetaColumna } from "./tipos";

export type RolColumna =
  | "fecha" // el eje temporal del reporte
  | "dimension" // sirve para agrupar
  | "codigo" // identifica, no se suma
  | "metrica" // magnitud que se agrega
  | "ignorada"; // constante o sin información

export interface ColumnaPlantilla {
  /** Texto exacto del encabezado en el Excel. */
  header: string;
  /** Nombre del campo al persistir en Mongo (inglés, como el resto de modelos). */
  campo: string;
  rol: RolColumna;
  /**
   * Tipo con el que viaja el valor al guardarlo. Se declara y no se infiere
   * porque el destino es un esquema fijo: `productCode` viene como número en
   * el Excel pero se guarda como texto, igual que `upc`, para que los códigos
   * se traten todos igual.
   */
  tipoDato: "date" | "number" | "string";
  /** Por qué se ignora; sólo para las de rol "ignorada". */
  motivo?: string;
}

export interface Plantilla {
  id: string;
  nombre: string;
  /** Cuenta a la que pertenece el reporte, como en el resto de retail. */
  account: string;
  columnas: ColumnaPlantilla[];
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
    { header: "Brand Desc", campo: "brand", rol: "dimension", tipoDato: "string" },
    { header: "Prime Item Nbr", campo: "primeItemNbr", rol: "codigo", tipoDato: "number" },
    { header: "Prime Item Desc", campo: "itemDesc", rol: "dimension", tipoDato: "string" },
    { header: "UPC", campo: "upc", rol: "codigo", tipoDato: "string" },
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
    { header: "POS Qty", campo: "posQty", rol: "metrica", tipoDato: "number" },
    { header: "POS Sales", campo: "posSales", rol: "metrica", tipoDato: "number" },
    { header: "Avg Price", campo: "avgPrice", rol: "metrica", tipoDato: "number" },
    { header: "Avg Sales $ per Store", campo: "avgSalesPerStore", rol: "metrica", tipoDato: "number" },
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
};

export const PLANTILLAS: Plantilla[] = [WALMART_MENSUAL];

export function plantillaPorId(id: string): Plantilla | null {
  return PLANTILLAS.find((p) => p.id === id) ?? null;
}

/** Métrica que se muestra por omisión cuando se reconoce la plantilla. */
const METRICA_PREFERIDA: Record<string, string> = {
  "walmart-mensual": "POS Sales",
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
      return { ...col, rol, campo: col.nombre, tipoDato };
    }

    return {
      ...col,
      rol: def.rol,
      campo: def.campo,
      tipoDato: def.tipoDato,
      // La plantilla manda: un código nunca se suma aunque venga como número, y
      // una columna ignorada queda fuera de todos los selectores.
      esIdentificador: def.rol === "codigo" || col.esIdentificador,
      esConstante: def.rol === "ignorada" ? true : col.esConstante,
    };
  });
}

/** Índice de la columna con ese rol, o -1. Para las selecciones por omisión. */
export function indicePorRol(columnas: ColumnaResuelta[], rol: RolColumna): number {
  return columnas.find((c) => c.rol === rol)?.indice ?? -1;
}

/**
 * Métrica por omisión de una plantilla: la preferida si está declarada, si no
 * la primera con rol de métrica.
 */
function indiceMetrica(columnas: ColumnaResuelta[], plantillaId: string): number {
  const preferida = METRICA_PREFERIDA[plantillaId];
  const metrica =
    (preferida
      ? columnas.find(
          (c) => c.rol === "metrica" && normalizar(c.nombre) === normalizar(preferida)
        )
      : undefined) ?? columnas.find((c) => c.rol === "metrica");
  return metrica?.indice ?? -1;
}

/** Filtros iniciales: dimensión, métrica y fecha según los roles declarados. */
export interface SeleccionInicial {
  idxDimension: number;
  idxMetrica: number;
  idxFecha: number;
}

function seleccionar(columnas: ColumnaResuelta[], plantillaId: string): SeleccionInicial {
  return {
    idxDimension: indicePorRol(columnas, "dimension"),
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
      nombre: c.header,
      campo: c.campo,
      rol: c.rol,
      tipoDato: c.tipoDato,
      tipo:
        c.tipoDato === "date" ? "fecha" : c.tipoDato === "number" ? "numero" : "categoria",
      noVacias: 0,
      cardinalidad: 0,
      esIdentificador: c.rol === "codigo",
      esConstante: false,
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
