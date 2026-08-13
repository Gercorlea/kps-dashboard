import { Schema, model, models, type Model, type Types } from "mongoose";

// Hoja "Fill Rate": una línea por posición de orden de compra (§6.2).
export interface ILineaOC {
  _id: Types.ObjectId;
  uploadId: Types.ObjectId;
  account: string;
  cutoffDate: Date;
  purchaseDoc: string;
  lineNumber: number | null;
  vendorCode: string;
  vendorName: string;
  sku: string;
  description: string;
  brand: string;
  division: string;
  orderDate: Date | null;
  allocatedQty: number | null;
  uom: string;
  deliveredQty: number | null;
  deliveryDate: Date | null;
  fillRate: number | null; // fracción: 1 = 100% (§7.5)
  poStatus: string;
  buyer: string;
  orderInUMA: number | null;
  purchaseDocRef: string;
  cpfr: string;
}

const LineaOCSchema = new Schema<ILineaOC>(
  {
    uploadId: { type: Schema.Types.ObjectId, ref: "Upload", required: true },
    account: { type: String, required: true },
    cutoffDate: { type: Date, required: true },
    purchaseDoc: { type: String, required: true },
    lineNumber: { type: Number, default: null },
    vendorCode: { type: String, default: "" },
    vendorName: { type: String, default: "" },
    sku: { type: String, required: true },
    description: { type: String, default: "" },
    brand: { type: String, default: "SIN CLASIFICAR" },
    division: { type: String, default: "" },
    orderDate: { type: Date, default: null },
    allocatedQty: { type: Number, default: null },
    uom: { type: String, default: "" },
    deliveredQty: { type: Number, default: null },
    deliveryDate: { type: Date, default: null },
    fillRate: { type: Number, default: null },
    poStatus: { type: String, default: "" },
    buyer: { type: String, default: "" },
    orderInUMA: { type: Number, default: null },
    purchaseDocRef: { type: String, default: "" },
    cpfr: { type: String, default: "" },
  },
  { versionKey: false }
);

LineaOCSchema.index({ account: 1, cutoffDate: -1 });
LineaOCSchema.index({ uploadId: 1 });
LineaOCSchema.index({ account: 1, cutoffDate: -1, buyer: 1 });

export const LineaOC: Model<ILineaOC> =
  (models.LineaOC as Model<ILineaOC>) ?? model<ILineaOC>("LineaOC", LineaOCSchema);
