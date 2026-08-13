import { Schema, model, models, type Model, type Types } from "mongoose";

// Hoja VENTAS en formato largo (unpivot §6.1): un documento por
// tienda × SKU × fecha. Habilita el histórico y el comparativo año contra año.
export interface IVentaDiaria {
  _id: Types.ObjectId;
  uploadId: Types.ObjectId;
  account: string;
  cutoffDate: Date;
  date: Date;
  storeCode: string; // "0141", nunca número
  storeName: string;
  sku: string;
  compositeId: string; // storeCode + sku
  description: string;
  brand: string; // derivada (lib/retail/brands.ts)
  division: string;
  vendorCode: string;
  vendorName: string;
  units: number;
}

const VentaDiariaSchema = new Schema<IVentaDiaria>(
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
    units: { type: Number, required: true },
  },
  { versionKey: false }
);

VentaDiariaSchema.index({ account: 1, date: -1, sku: 1 });
VentaDiariaSchema.index({ uploadId: 1 });
VentaDiariaSchema.index({ account: 1, brand: 1, date: -1 });

export const VentaDiaria: Model<IVentaDiaria> =
  (models.VentaDiaria as Model<IVentaDiaria>) ??
  model<IVentaDiaria>("VentaDiaria", VentaDiariaSchema);
