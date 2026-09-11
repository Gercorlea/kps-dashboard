// El mapa encabezado del Excel → campo de Mongo, y su resolución.
//
// El catálogo tiene un layout FIJO y conocido, al contrario que el analizador de
// /retail/analisis: ahí hay que adivinar la forma de un archivo desconocido
// (construirDataset + inferir-tipos), y aquí las columnas se declaran. Se copia
// la idea de plantillas.ts pero no su tipo: ColumnaPlantilla está soldada a los
// conceptos del analizador (rol, filtro, agregado, moneda) y un catálogo no
// tiene métricas ni dimensiones ni gráficas.

import { clave } from "./normalizar";

export type TipoCelda = "texto" | "codigo" | "numero" | "fecha" | "lista";

export interface ColumnaCatalogo {
  /** Campo en Mongo (inglés, como el resto de src/models). */
  campo: string;
  /** Cómo se llama en la interfaz (español). */
  etiqueta: string;
  /**
   * Encabezados aceptados, YA normalizados con clave(). El primero es el
   * canónico y es el que se nombra en los mensajes.
   *
   * Son alias y no un texto exacto porque el archivo lo mantiene una persona:
   * "Descripcion" y "Descripción", "clave SAT" y "Clave SAT", "Fracción
   * Arancelaria" con espacio final. Rechazar el archivo por un acento sería
   * inaceptable en el único flujo de carga del módulo.
   */
  alias: string[];
  tipo: TipoCelda;
  /**
   * La COLUMNA tiene que existir en la hoja y la CELDA no puede ir vacía.
   *
   * Sólo cuatro en la hoja 1 (item, descripcion, estatus, linea) y dos en la
   * hoja 2 (sku, canal). Si falta la columna se rechaza el archivo nombrándola;
   * si falta la celda se descarta la fila y se reporta con su número.
   */
  requerida?: boolean;
  /**
   * Se espera en el archivo aunque pueda faltar: la tabla la pinta, así que su
   * ausencia deja una columna en blanco y hay que decir por qué. Incidencia
   * `aviso` (visible en la cabecera) en vez de `info`.
   */
  esperada?: boolean;
  /** Varias columnas del Excel que colapsan en un arreglo (Proveedor 1..3). */
  grupo?: { alias: string[] }[];
}

// Hoja 1. El orden importa: la resolución recorre esta lista y una columna ya
// asignada no se reasigna, así que los descriptores más específicos van antes
// que los que comparten un alias genérico.
export const COLUMNAS_PRODUCTO: ColumnaCatalogo[] = [
  {
    campo: "item",
    etiqueta: "Item",
    tipo: "codigo",
    requerida: true,
    alias: ["item", "codigo item", "clave item", "clave", "sku"],
  },
  {
    campo: "description",
    etiqueta: "Descripción",
    tipo: "texto",
    requerida: true,
    alias: ["descripcion", "descripcion del producto", "nombre", "producto"],
  },
  {
    campo: "status",
    etiqueta: "Estatus",
    tipo: "texto",
    requerida: true,
    alias: ["estatus", "estado", "status"],
  },
  {
    campo: "line",
    etiqueta: "Línea",
    tipo: "texto",
    requerida: true,
    alias: ["linea", "linea de producto", "familia", "marca"],
  },
  {
    campo: "salesUnit",
    etiqueta: "Unidad de venta",
    tipo: "texto",
    esperada: true,
    alias: ["unidad", "unidad de venta", "unidad venta", "unidad de medida", "um"],
  },
  {
    campo: "upc",
    etiqueta: "UPC",
    tipo: "codigo",
    esperada: true,
    alias: ["upc", "codigo de barras", "codigo barras", "ean"],
  },
  {
    campo: "launchDate",
    etiqueta: "Fecha de lanzamiento",
    tipo: "fecha",
    esperada: true,
    alias: ["fecha lanzamiento", "fecha de lanzamiento", "lanzamiento"],
  },
  { campo: "ecom", etiqueta: "ECOM", tipo: "texto", alias: ["ecom", "e com", "ecommerce", "e-commerce"] },
  { campo: "trello", etiqueta: "Trello", tipo: "texto", alias: ["trello"] },
  {
    campo: "satCode",
    etiqueta: "Clave SAT",
    tipo: "codigo",
    alias: ["clave sat", "clave del sat", "sat", "clave prod serv", "clave producto servicio"],
  },
  {
    campo: "tariffCode",
    etiqueta: "Fracción arancelaria",
    tipo: "codigo",
    alias: ["fraccion arancelaria", "fraccion", "arancel", "codigo arancelario"],
  },
  { campo: "suv", etiqueta: "SUV", tipo: "texto", alias: ["suv"] },
  {
    campo: "grammage",
    etiqueta: "Gramaje",
    tipo: "numero",
    alias: ["gramaje", "gramos", "peso", "contenido"],
  },
  {
    campo: "shelfLifeMonths",
    etiqueta: "Meses de caducidad",
    tipo: "numero",
    alias: ["meses de caducidad", "caducidad meses", "meses caducidad", "vida util", "caducidad"],
  },
  {
    campo: "suppliers",
    etiqueta: "Proveedores",
    tipo: "lista",
    alias: ["proveedor 1"],
    grupo: [
      { alias: ["proveedor 1", "proveedor1", "proveedor"] },
      { alias: ["proveedor 2", "proveedor2"] },
      { alias: ["proveedor 3", "proveedor3"] },
    ],
  },
];

// Hoja 2. `sku` y `channel` son requeridos porque una fila sin producto o sin
// canal no mapea nada y no tiene clave bajo la que guardarse. `customerCode`
// puede ir vacío: es el caso normal de un producto que la cadena no ha dado de
// alta todavía.
export const COLUMNAS_MAPEO: ColumnaCatalogo[] = [
  {
    campo: "sku",
    etiqueta: "SKU",
    tipo: "codigo",
    requerida: true,
    alias: ["sku", "item", "clave", "codigo producto"],
  },
  {
    campo: "channel",
    etiqueta: "Canal",
    tipo: "texto",
    requerida: true,
    alias: ["canal", "cadena", "cliente", "retailer", "tienda"],
  },
  {
    campo: "customerCode",
    etiqueta: "Código cliente",
    tipo: "codigo",
    esperada: true,
    alias: ["codigo cliente", "codigo de cliente", "clave cliente", "numero de cliente", "codigo"],
  },
  {
    campo: "description",
    etiqueta: "Descripción",
    tipo: "texto",
    esperada: true,
    alias: ["descripcion", "descripcion cliente", "descripcion del cliente"],
  },
];

/** Dónde quedó cada campo: índice de columna en la hoja, o -1 si no se encontró. */
export interface Resolucion {
  /** campo → índice de columna. Sólo los que se encontraron. */
  indices: Map<string, number>;
  /** campo → índices del grupo (Proveedor 1..3), en orden. */
  grupos: Map<string, number[]>;
  /** Descriptores que no se pudieron resolver. */
  faltantes: ColumnaCatalogo[];
}

/**
 * Resuelve encabezados → campos en DOS pasadas.
 *
 * Importa que sean dos y en este orden porque hay alias compartidos: "codigo"
 * es alias de `customerCode` y "clave"/"item" lo son de `sku` y de `item`. La
 * igualdad exacta se agota antes de permitir cualquier coincidencia parcial, de
 * modo que un encabezado que calza exactamente con un campo nunca se lo lleva
 * otro por contención.
 *
 * Invariantes: una columna del Excel se asigna a un solo campo, y un campo se
 * queda con una sola columna.
 */
export function resolverColumnas(
  encabezados: unknown[],
  columnas: ColumnaCatalogo[]
): Resolucion {
  const claves = encabezados.map((h) => clave(h));
  const tomadas = new Set<number>();
  const indices = new Map<string, number>();
  const grupos = new Map<string, number[]>();

  // Los grupos (Proveedor 1..3) van PRIMERO y por igualdad exacta: son columnas
  // hermanas, y si se resolvieran al final la pasada de contención podría
  // haberse llevado ya "Proveedor 2" para otro campo sin dueño. Resolverlas
  // antes y marcarlas tomadas es lo que hace verdad el invariante de que una
  // columna del Excel pertenece a un solo campo.
  for (const col of columnas) {
    if (!col.grupo) continue;
    const idx: number[] = [];
    for (const parte of col.grupo) {
      const i = claves.findIndex((c, j) => c !== "" && !tomadas.has(j) && parte.alias.includes(c));
      if (i >= 0) {
        idx.push(i);
        tomadas.add(i);
      }
    }
    if (idx.length > 0) {
      grupos.set(col.campo, idx);
      indices.set(col.campo, idx[0]);
    }
  }

  // Pasada 1: igualdad exacta, recorriendo los descriptores en orden de lista.
  for (const col of columnas) {
    if (indices.has(col.campo)) continue;
    for (let i = 0; i < claves.length; i++) {
      if (tomadas.has(i) || !claves[i]) continue;
      if (col.alias.includes(claves[i])) {
        indices.set(col.campo, i);
        tomadas.add(i);
        break;
      }
    }
  }

  // Pasada 2: contención, sólo para los campos que quedaron sin columna y las
  // columnas sin dueño. Es lo que salva un "Fecha de lanzamiento del producto".
  for (const col of columnas) {
    if (indices.has(col.campo)) continue;
    for (let i = 0; i < claves.length; i++) {
      if (tomadas.has(i) || !claves[i]) continue;
      const c = claves[i];
      if (col.alias.some((a) => c.includes(a) || a.includes(c))) {
        indices.set(col.campo, i);
        tomadas.add(i);
        break;
      }
    }
  }

  const faltantes = columnas.filter((c) => !indices.has(c.campo));
  return { indices, grupos, faltantes };
}

/** Cuántos alias distintos de `columnas` calzan en una fila. Para elegir el encabezado. */
export function puntuarEncabezado(fila: unknown[], columnas: ColumnaCatalogo[]): number {
  const claves = new Set(fila.map((h) => clave(h)).filter(Boolean));
  let n = 0;
  for (const col of columnas) {
    if (col.alias.some((a) => claves.has(a))) n++;
  }
  return n;
}

/** Si una fila trae TODAS las columnas requeridas. Condición del encabezado. */
export function tieneRequeridas(fila: unknown[], columnas: ColumnaCatalogo[]): boolean {
  const { indices } = resolverColumnas(fila, columnas);
  return columnas.filter((c) => c.requerida).every((c) => indices.has(c.campo));
}
