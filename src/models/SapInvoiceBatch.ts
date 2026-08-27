import { Schema, model, models, type Model, type Types } from "mongoose";

// Lotes (batches) asignados a cada línea de factura de SAP: una fila por
// (factura, línea, lote) con la cantidad que salió de ese lote.
//
// Existe para responder "el lote más vendido" o "qué lotes se le vendieron a
// X": esa información vive en la colección anidada BatchNumbers de cada línea
// y el Service Layer no sabe agregarla. Se llena junto con sapSales en
// lib/sap/sincronizar-facturas.ts; las facturas copiadas ANTES de que
// existiera esta colección sólo se completan con una sincronización desde
// cero (`npm run sap:facturas -- --completo`).
export interface ISapInvoiceBatch {
  _id: Types.ObjectId;
  docEntry: number;
  lineNum: number;
  batch: string;
  docNum: number;
  docDate: Date;
  cardCode: string;
  cardName: string;
  itemCode: string;
  description: string;
  quantity: number; // unidades de ESTE lote en la línea
  expiryDate: Date | null; // caducidad del lote si SAP la manda en la línea
  syncedAt: Date;
}

const SapInvoiceBatchSchema = new Schema<ISapInvoiceBatch>(
  {
    docEntry: { type: Number, required: true },
    lineNum: { type: Number, required: true },
    batch: { type: String, required: true },
    docNum: { type: Number, required: true },
    docDate: { type: Date, required: true },
    cardCode: { type: String, default: "" },
    cardName: { type: String, default: "" },
    itemCode: { type: String, required: true },
    description: { type: String, default: "" },
    quantity: { type: Number, required: true },
    expiryDate: { type: Date, default: null },
    syncedAt: { type: Date, required: true },
  },
  { versionKey: false }
);

SapInvoiceBatchSchema.index({ docEntry: 1, lineNum: 1, batch: 1 }, { unique: true });
SapInvoiceBatchSchema.index({ batch: 1, docDate: -1 });
SapInvoiceBatchSchema.index({ itemCode: 1, docDate: -1 });
SapInvoiceBatchSchema.index({ docDate: -1 });

export const SapInvoiceBatch: Model<ISapInvoiceBatch> =
  (models.SapInvoiceBatch as Model<ISapInvoiceBatch>) ??
  model<ISapInvoiceBatch>("SapInvoiceBatch", SapInvoiceBatchSchema);
