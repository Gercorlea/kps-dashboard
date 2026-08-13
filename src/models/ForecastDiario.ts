import { Schema, model, models, type Model, type Types } from "mongoose";

// Hoja FC_Mean (unpivot). Excluye "Total" y "Total red": los totales se
// recalculan al consultar, nunca se cachean del Excel (§7.2).
export interface IForecastDiario {
  _id: Types.ObjectId;
  uploadId: Types.ObjectId;
  account: string;
  cutoffDate: Date;
  date: Date;
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

const ForecastDiarioSchema = new Schema<IForecastDiario>(
  {
    uploadId: { type: Schema.Types.ObjectId, ref: "Upload", required: true },
    account: { type: String, required: true },
    cutoffDate: { type: Date, required: true },
    date: { type: Date, required: true },
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

ForecastDiarioSchema.index({ account: 1, date: -1, sku: 1 });
ForecastDiarioSchema.index({ uploadId: 1 });

export const ForecastDiario: Model<IForecastDiario> =
  (models.ForecastDiario as Model<IForecastDiario>) ??
  model<IForecastDiario>("ForecastDiario", ForecastDiarioSchema);
