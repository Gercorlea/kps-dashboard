import { Schema, model, models, type Model, type Types } from "mongoose";

// Hoja 1 del Excel del catálogo de KPS: un documento por Item POR CARGA.
//
// El grano no es el producto, es (carga, producto). Cada subida reemplaza al
// catálogo completo, y el reemplazo se hace insertando la carga nueva ENTERA
// antes de tirar la vieja (ver lib/catalogo/cargas.ts): mientras la nueva se
// escribe conviven las dos, así que `loadId` es parte de la identidad y tiene
// que estar en TODAS las lecturas. Una consulta del módulo sin `loadId` es un
// error, no una optimización.
export interface ICatalogProduct {
  _id: Types.ObjectId;
  loadId: string;

  /**
   * "PTAL001". Normalizado con normalizarItem (toCode + trim + MAYÚSCULAS): es
   * la clave del cruce con ProductMapping.sku y el archivo mezcla "ptal001 "
   * con "PTAL001". Sin normalizar, esas dos filas serían productos distintos y
   * las ventas de una se perderían en silencio.
   */
  item: string;
  description: string;
  status: string; // "Activo", "Descatalogado"; texto libre del archivo
  line: string; // "bloom", "goli"

  /**
   * ECOM y Trello se guardan como texto libre y NO como enum de tres estados.
   * El vocabulario lo pone quien mantiene el Excel ("si"/"Sí"/"SI",
   * "ok"/"OK"/"NA"), y un enum obligaría a vaciar o rechazar un valor que la
   * persona escribió a propósito. Se guarda y se muestra tal cual.
   */
  ecom: string;
  trello: string;

  salesUnit: string; // "Pz", "Paq"

  /**
   * Códigos SIEMPRE texto: el UPC trae cero a la izquierda ("0750229353070")
   * y pasarlo por Number() lo perdería, igual que SalesReport.upc.
   */
  upc: string;
  satCode: string; // "clave SAT"
  tariffCode: string; // "Fracción Arancelaria"
  suv: string; // "DER", "SUA"

  /** Ausente ≠ 0 (§7.5 de retail): una celda vacía o "ND" es null. */
  grammage: number | null;
  shelfLifeMonths: number | null;

  /** "1-Sep-24" → medianoche UTC, como el resto de retail. */
  launchDate: Date | null;
  /**
   * El texto original cuando no se pudo interpretar. Sin esto una fecha con
   * formato raro desaparece de la ficha y nadie sabe que el archivo la traía.
   */
  launchDateText: string;

  /**
   * Proveedor 1..3 colapsados, sin vacíos y en orden. Son la misma columna
   * repetida tres veces; un arreglo evita tres campos casi siempre nulos.
   */
  suppliers: string[];

  /** Fila real de Excel (1-based), para poder auditar contra el archivo. */
  rowNumber: number;
}

const CatalogProductSchema = new Schema<ICatalogProduct>(
  {
    loadId: { type: String, required: true },

    // Los cuatro obligatorios. Si la celda no puede ir vacía, la columna tiene
    // que existir: el lector rechaza el archivo que no las traiga y descarta la
    // fila a la que le falte alguna (ver lib/catalogo/columnas.ts).
    item: { type: String, required: true },
    description: { type: String, required: true },
    status: { type: String, required: true },
    line: { type: String, required: true },

    ecom: { type: String, default: "" },
    trello: { type: String, default: "" },
    salesUnit: { type: String, default: "" },
    upc: { type: String, default: "" },
    satCode: { type: String, default: "" },
    tariffCode: { type: String, default: "" },
    suv: { type: String, default: "" },
    grammage: { type: Number, default: null },
    shelfLifeMonths: { type: Number, default: null },
    launchDate: { type: Date, default: null },
    launchDateText: { type: String, default: "" },
    suppliers: { type: [String], default: [] },
    rowNumber: { type: Number, default: 0 },
  },
  { versionKey: false }
);

// Identidad del grano, y el `item` siempre está. Hace tres cosas a la vez:
//  · el upsert por lote es idempotente, así que reintentar un lote no duplica;
//  · un Item repetido en la hoja no crea dos filas (gana el último);
//  · (loadId, item) es orden TOTAL, así que la paginación de la tabla no puede
//    mostrar una fila en dos páginas ni saltársela.
CatalogProductSchema.index({ loadId: 1, item: 1 }, { unique: true });

// El cruce inverso: ¿qué producto tiene este UPC? No es único a propósito —dos
// presentaciones pueden compartir código de barras y eso no es un error.
CatalogProductSchema.index({ loadId: 1, upc: 1 });

export const CatalogProduct: Model<ICatalogProduct> =
  (models.CatalogProduct as Model<ICatalogProduct>) ??
  model<ICatalogProduct>("CatalogProduct", CatalogProductSchema);
