import { Schema, model, models, type Model, type Types } from "mongoose";

// Copia local de las líneas de factura de SAP: una fila por línea de venta.
// Existe porque el Service Layer NO sabe agregar a nivel de línea ($expand,
// $crossjoin y $apply sobre líneas están rechazados — verificado en vivo), y
// sin esto responder "el producto más vendido de la historia" exigiría ~450
// peticiones a SAP por pregunta. Se llena con lib/sap/sincronizar-facturas.ts
// (incremental por docEntry) y la lee consultar_retail como "sapSales".
export interface ISapInvoiceLine {
  _id: Types.ObjectId;
  docEntry: number; // llave interna SAP; con lineNum identifica la línea
  lineNum: number;
  docNum: number; // folio que ve el usuario
  docDate: Date;
  cardCode: string;
  cardName: string;
  itemCode: string;
  description: string;
  quantity: number;
  price: number; // unitario, en MXP
  lineTotal: number; // importe de la línea, en MXP
  currency: string;
  syncedAt: Date;
}

const SapInvoiceLineSchema = new Schema<ISapInvoiceLine>(
  {
    docEntry: { type: Number, required: true },
    lineNum: { type: Number, required: true },
    docNum: { type: Number, required: true },
    docDate: { type: Date, required: true },
    cardCode: { type: String, default: "" },
    cardName: { type: String, default: "" },
    itemCode: { type: String, required: true },
    description: { type: String, default: "" },
    quantity: { type: Number, required: true },
    price: { type: Number, default: 0 },
    lineTotal: { type: Number, default: 0 },
    currency: { type: String, default: "MXP" },
    syncedAt: { type: Date, required: true },
  },
  { versionKey: false }
);

// La sincronización upsertea por (docEntry, lineNum): reimportar no duplica.
SapInvoiceLineSchema.index({ docEntry: 1, lineNum: 1 }, { unique: true });
SapInvoiceLineSchema.index({ itemCode: 1, docDate: -1 });
SapInvoiceLineSchema.index({ cardCode: 1, docDate: -1 });
SapInvoiceLineSchema.index({ docDate: -1 });

export const SapInvoiceLine: Model<ISapInvoiceLine> =
  (models.SapInvoiceLine as Model<ISapInvoiceLine>) ??
  model<ISapInvoiceLine>("SapInvoiceLine", SapInvoiceLineSchema);
