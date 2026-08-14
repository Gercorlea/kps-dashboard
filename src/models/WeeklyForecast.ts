import { Schema, model, models, type Model, type Types } from "mongoose";

// Hoja PRONOSTICOS (unpivot): un documento por tienda × SKU × semana.
export interface IWeeklyForecast {
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

const WeeklyForecastSchema = new Schema<IWeeklyForecast>(
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

WeeklyForecastSchema.index({ account: 1, weekStart: -1, sku: 1 });
WeeklyForecastSchema.index({ uploadId: 1 });

export const WeeklyForecast: Model<IWeeklyForecast> =
  (models.WeeklyForecast as Model<IWeeklyForecast>) ??
  model<IWeeklyForecast>("WeeklyForecast", WeeklyForecastSchema);
