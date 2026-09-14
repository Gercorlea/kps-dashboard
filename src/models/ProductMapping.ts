import { Schema, model, models, type Model, type Types } from "mongoose";

// Hoja 2 del Excel del catálogo: el código con el que cada cadena llama a cada
// producto de KPS. El mismo sku se repite con distinto canal, así que el grano
// es (carga, sku, canal).
//
// Es la pieza que ata el catálogo con las ventas: SalesReport guarda el
// `itemNbr` del retailer, no el Item de KPS, y sin este mapeo no hay forma de
// responder "cuántas unidades de PTAL001 vendió Walmart".
export interface IProductMapping {
  _id: Types.ObjectId;
  loadId: string;

  /** Normalizado con la MISMA función que CatalogProduct.item. */
  sku: string;

  /**
   * Slug del canal: "walmart", "san-pablo". Se acepta CUALQUIER texto y se
   * convierte a slug (lib/catalogo/canales.ts) en vez de rechazarlo: el archivo
   * trae cadenas que todavía no son retailers del módulo, y perder esas filas
   * sería perder el trabajo de quien mantiene el Excel.
   */
  channel: string;
  /** Nombre oficial si el canal es conocido, texto original del archivo si no. */
  channelName: string;
  /** Si el canal está en RETAILERS. Sólo los conocidos cruzan con ventas. */
  knownRetailer: boolean;

  /**
   * El código del cliente TAL COMO viene: texto, porque puede traer cero a la
   * izquierda o no ser numérico ("A-1004"). Es el dato que se muestra.
   *
   * Puede ir vacío: es el caso normal de un producto que la cadena todavía no
   * ha dado de alta.
   */
  customerCode: string;
  /**
   * El MISMO código como número, o null.
   *
   * Existe sólo para cruzar con SalesReport.itemNbr, que es Number: en Mongo un
   * String nunca iguala a un Number, y convertir con $toLong dentro del
   * pipeline inutilizaría el índice { account, itemNbr, date }. Se precalcula
   * al cargar para que la consulta de la ficha sea una igualdad indexada.
   *
   * Sólo se llena si el texto es un ENTERO completo: "1004.5" y "A-1004" quedan
   * en null y su fila se muestra sin ventas, en vez de cruzar con un itemNbr
   * inventado y atribuirle a un producto las ventas de otro.
   */
  customerCodeNum: number | null;

  description: string;
  rowNumber: number;
}

const ProductMappingSchema = new Schema<IProductMapping>(
  {
    loadId: { type: String, required: true },

    // Una fila de mapeo sin producto o sin canal no mapea nada y no tiene clave
    // bajo la que guardarse; el lector la descarta y la reporta.
    sku: { type: String, required: true },
    channel: { type: String, required: true },

    channelName: { type: String, default: "" },
    knownRetailer: { type: Boolean, default: false },
    customerCode: { type: String, default: "" },
    customerCodeNum: { type: Number, default: null },
    description: { type: String, default: "" },
    rowNumber: { type: Number, default: 0 },
  },
  { versionKey: false }
);

// Identidad del grano: hace idempotente el reintento de un lote y colapsa un
// (sku, canal) repetido en la hoja.
ProductMappingSchema.index({ loadId: 1, sku: 1, channel: 1 }, { unique: true });

// La tabla de "Mapeo de productos" ordena por canal y luego por sku; con
// `channel` delante sirve además para las facetas (canales distintos de la
// carga) sin recorrer la colección.
ProductMappingSchema.index({ loadId: 1, channel: 1, sku: 1 });

export const ProductMapping: Model<IProductMapping> =
  (models.ProductMapping as Model<IProductMapping>) ??
  model<IProductMapping>("ProductMapping", ProductMappingSchema);
