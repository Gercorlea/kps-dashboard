import { Schema, model, models, type Model, type Types } from "mongoose";

// Hoja PRONOSTICOS (unpivot): un documento por tienda × SKU × semana.
export interface IPronosticoSemanal {
  _id: Types.ObjectId;
  uploadId: Types.ObjectId;
  account: string;
  cutoffDate: Date;
  weekStart: Date;
  storeCode: string;
  storeName: string;
  sku: string;
  compositeId: string;
  description: string;
  brand: string;
  division: string;
  vendorCode: string;
  vendorName: string;
  value: number;
}

const PronosticoSemanalSchema = new Schema<IPronosticoSemanal>(
  {
    uploadId: { type: Schema.Types.ObjectId, ref: "Upload", required: true },
    account: { type: String, required: true },
    cutoffDate: { type: Date, required: true },
    weekStart: { type: Date, required: true },
    storeCode: { type: String, required: true },
    storeName: { type: String, default: "" },
    sku: { type: String, required: true },
    compositeId: { type: String, default: "" },
    description: { type: String, default: "" },
    brand: { type: String, default: "SIN CLASIFICAR" },
    division: { type: String, default: "" },
    vendorCode: { type: String, default: "" },
    vendorName: { type: String, default: "" },
    value: { type: Number, required: true },
  },
  { versionKey: false }
);

PronosticoSemanalSchema.index({ account: 1, weekStart: -1, sku: 1 });
PronosticoSemanalSchema.index({ uploadId: 1 });

export const PronosticoSemanal: Model<IPronosticoSemanal> =
  (models.PronosticoSemanal as Model<IPronosticoSemanal>) ??
  model<IPronosticoSemanal>("PronosticoSemanal", PronosticoSemanalSchema);
