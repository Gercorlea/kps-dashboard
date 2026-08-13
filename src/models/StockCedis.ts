import { Schema, model, models, type Model, type Types } from "mongoose";

// Hoja CEDIS: una fila por SKU en el centro de distribución. Las columnas
// de fecha (citas) van en medio de la tabla y se guardan como unpivot
// embebido (§6.2, §7.2).
export interface ICitaCedis {
  date: Date;
  quantity: number;
}

export interface IStockCedis {
  _id: Types.ObjectId;
  uploadId: Types.ObjectId;
  account: string;
  cutoffDate: Date;
  sku: string;
  description: string;
  brand: string;
  division: string;
  vendorCode: string;
  vendorName: string;
  realAvailabilityDC: number | null;
  inTransit: number | null;
  withoutAppointment: number | null;
  appointments: ICitaCedis[];
  planCharacteristic: string; // viene "21", "ND" → string, no número
  minimum: number | null;
  coverage: number | null;
  reorderPoint: number | null;
  targetStock: number | null;
}

const StockCedisSchema = new Schema<IStockCedis>(
  {
    uploadId: { type: Schema.Types.ObjectId, ref: "Upload", required: true },
    account: { type: String, required: true },
    cutoffDate: { type: Date, required: true },
    sku: { type: String, required: true },
    description: { type: String, default: "" },
    brand: { type: String, default: "SIN CLASIFICAR" },
    division: { type: String, default: "" },
    vendorCode: { type: String, default: "" },
    vendorName: { type: String, default: "" },
    realAvailabilityDC: { type: Number, default: null },
    inTransit: { type: Number, default: null },
    withoutAppointment: { type: Number, default: null },
    appointments: {
      type: [
        new Schema<ICitaCedis>(
          {
            date: { type: Date, required: true },
            quantity: { type: Number, required: true },
          },
          { _id: false }
        ),
      ],
      default: [],
    },
    planCharacteristic: { type: String, default: "" },
    minimum: { type: Number, default: null },
    coverage: { type: Number, default: null },
    reorderPoint: { type: Number, default: null },
    targetStock: { type: Number, default: null },
  },
  { versionKey: false }
);

StockCedisSchema.index({ account: 1, cutoffDate: -1, sku: 1 });
StockCedisSchema.index({ uploadId: 1 });

export const StockCedis: Model<IStockCedis> =
  (models.StockCedis as Model<IStockCedis>) ??
  model<IStockCedis>("StockCedis", StockCedisSchema);
