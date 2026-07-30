import { Schema, model, models, type Model, type Types } from "mongoose";

// Hoja "Inv Farma": inventario por farmacia × SKU (§6.2).
export interface IStockFarmacia {
  _id: Types.ObjectId;
  uploadId: Types.ObjectId;
  cuenta: string;
  fechaCorte: Date;
  idCompuesto: string;
  codigoTienda: string;
  nombreTienda: string;
  sku: string;
  descripcion: string;
  marca: string;
  division: string;
  numProveedor: string;
  nombreProveedor: string;
  tipoArticulo: string;
  abc: string;
  sm: string;
  cap: string;
  stockSegMin: number | null;
  cobertObjMin: number | null;
  stockObjetivo: number | null;
  puntoPedido: number | null;
  stockDinamico: number | null;
  stockMaximo: number | null;
  libreUtilizacion: number | null;
  transitoFarma: number | null;
  sellingClass: number | null;
  nivelInventario: number | null;
}

const StockFarmaciaSchema = new Schema<IStockFarmacia>(
  {
    uploadId: { type: Schema.Types.ObjectId, ref: "Upload", required: true },
    cuenta: { type: String, required: true },
    fechaCorte: { type: Date, required: true },
    idCompuesto: { type: String, default: "" },
    codigoTienda: { type: String, required: true },
    nombreTienda: { type: String, default: "" },
    sku: { type: String, required: true },
    descripcion: { type: String, default: "" },
    marca: { type: String, default: "SIN CLASIFICAR" },
    division: { type: String, default: "" },
    numProveedor: { type: String, default: "" },
    nombreProveedor: { type: String, default: "" },
    tipoArticulo: { type: String, default: "" },
    abc: { type: String, default: "" },
    sm: { type: String, default: "" },
    cap: { type: String, default: "" },
    stockSegMin: { type: Number, default: null },
    cobertObjMin: { type: Number, default: null },
    stockObjetivo: { type: Number, default: null },
    puntoPedido: { type: Number, default: null },
    stockDinamico: { type: Number, default: null },
    stockMaximo: { type: Number, default: null },
    libreUtilizacion: { type: Number, default: null },
    transitoFarma: { type: Number, default: null },
    sellingClass: { type: Number, default: null },
    nivelInventario: { type: Number, default: null },
  },
  { versionKey: false }
);

StockFarmaciaSchema.index({ cuenta: 1, fechaCorte: -1, sku: 1 });
StockFarmaciaSchema.index({ uploadId: 1 });
StockFarmaciaSchema.index({ cuenta: 1, fechaCorte: -1, marca: 1 });

export const StockFarmacia: Model<IStockFarmacia> =
  (models.StockFarmacia as Model<IStockFarmacia>) ??
  model<IStockFarmacia>("StockFarmacia", StockFarmaciaSchema);
