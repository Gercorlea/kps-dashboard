import { Schema, model, models, type Model, type Types } from "mongoose";

// Hoja "Inv Farma": inventario por farmacia × SKU (§6.2).
export interface IPharmacyStock {
  _id: Types.ObjectId;
  uploadId: Types.ObjectId;
  account: string;
  cutoffDate: Date;
  compositeId: string;
  storeCode: string;
  storeName: string;
  sku: string;
  description: string;
  brand: string;
  division: string;
  vendorCode: string;
  vendorName: string;
  itemType: string;
  abc: string;
  sm: string;
  cap: string;
  minSafetyStock: number | null;
  minTargetCoverage: number | null;
  targetStock: number | null;
  reorderPoint: number | null;
  dynamicStock: number | null;
  maxStock: number | null;
  unrestrictedStock: number | null;
  pharmacyInTransit: number | null;
  sellingClass: number | null;
  inventoryLevel: number | null;
}

const PharmacyStockSchema = new Schema<IPharmacyStock>(
  {
    uploadId: { type: Schema.Types.ObjectId, ref: "Upload", required: true },
    account: { type: String, required: true },
    cutoffDate: { type: Date, required: true },
    compositeId: { type: String, default: "" },
    storeCode: { type: String, required: true },
    storeName: { type: String, default: "" },
    sku: { type: String, required: true },
    description: { type: String, default: "" },
    brand: { type: String, default: "SIN CLASIFICAR" },
    division: { type: String, default: "" },
    vendorCode: { type: String, default: "" },
    vendorName: { type: String, default: "" },
    itemType: { type: String, default: "" },
    abc: { type: String, default: "" },
    sm: { type: String, default: "" },
    cap: { type: String, default: "" },
    minSafetyStock: { type: Number, default: null },
    minTargetCoverage: { type: Number, default: null },
    targetStock: { type: Number, default: null },
    reorderPoint: { type: Number, default: null },
    dynamicStock: { type: Number, default: null },
    maxStock: { type: Number, default: null },
    unrestrictedStock: { type: Number, default: null },
    pharmacyInTransit: { type: Number, default: null },
    sellingClass: { type: Number, default: null },
    inventoryLevel: { type: Number, default: null },
  },
  { versionKey: false }
);

PharmacyStockSchema.index({ account: 1, cutoffDate: -1, sku: 1 });
PharmacyStockSchema.index({ uploadId: 1 });
PharmacyStockSchema.index({ account: 1, cutoffDate: -1, brand: 1 });

export const PharmacyStock: Model<IPharmacyStock> =
  (models.PharmacyStock as Model<IPharmacyStock>) ??
  model<IPharmacyStock>("PharmacyStock", PharmacyStockSchema);
