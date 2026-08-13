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
import type { Dataset, FilaCruda, MetaColumna } from "./tipos";

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
 * Selección inicial de filtros para un dataset con plantilla reconocida.
 * Devuelve null si no calza ninguna, para que el llamador use la inferencia.
 */
export function seleccionDePlantilla(
  dataset: Dataset
): { plantilla: Plantilla; columnas: ColumnaResuelta[]; idxDimension: number; idxMetrica: number; idxFecha: number } | null {
  const plantilla = reconocerPlantilla(dataset.columnas);
  if (!plantilla) return null;

  const columnas = aplicarPlantilla(dataset.columnas, plantilla);
  const preferida = METRICA_PREFERIDA[plantilla.id];
  const metrica =
    (preferida
      ? columnas.find((c) => c.rol === "metrica" && normalizar(c.nombre) === normalizar(preferida))
      : undefined) ?? columnas.find((c) => c.rol === "metrica");

  return {
    plantilla,
    columnas,
    idxDimension: indicePorRol(columnas, "dimension"),
    idxMetrica: metrica?.indice ?? -1,
    idxFecha: indicePorRol(columnas, "fecha"),
  };
}

// ------------------------------------------------- del histórico a la tabla

/**
 * Columnas de la tabla cuando las filas vienen de Mongo y no de un Excel.
 *
 * El histórico guarda exactamente las columnas útiles de la plantilla, así que
 * no hay nada que inferir: los tipos y los roles ya están declarados arriba.
 * Se sintetiza un MetaColumna por cada una para que la tabla, el formateo de
 * celdas y el buscador sean el MISMO código en los dos modos.
 */
export interface ColumnaHistorico extends MetaColumna {
  campo: string;
}

export function columnasHistorico(plantilla: Plantilla): ColumnaHistorico[] {
  return plantilla.columnas
    .filter((c) => c.rol !== "ignorada")
    .map((c, i) => ({
      // El índice es la posición en ESTA lista, no en el Excel: las filas se
      // arman en el mismo orden justo abajo.
      indice: i,
      nombre: c.header,
      campo: c.campo,
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

/** Documento del histórico → fila cruda, en el orden de `columnasHistorico`. */
export function filaCrudaDesdeHistorico(
  doc: Record<string, unknown>,
  columnas: ColumnaHistorico[]
): FilaCruda {
  return columnas.map((c) => {
    const v = doc[c.campo];
    if (v === null || v === undefined) return null;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
    return String(v);
  });
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
