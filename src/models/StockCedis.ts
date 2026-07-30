import { Schema, model, models, type Model, type Types } from "mongoose";

// Hoja CEDIS: una fila por SKU en el centro de distribución. Las columnas
// de fecha (citas) van en medio de la tabla y se guardan como unpivot
// embebido (§6.2, §7.2).
export interface ICitaCedis {
  fecha: Date;
  cantidad: number;
}

export interface IStockCedis {
  _id: Types.ObjectId;
  uploadId: Types.ObjectId;
  cuenta: string;
  fechaCorte: Date;
  sku: string;
  descripcion: string;
  marca: string;
  division: string;
  numProveedor: string;
  proveedor: string;
  disponibilidadRealCD: number | null;
  transitos: number | null;
  sinCita: number | null;
  citas: ICitaCedis[];
  caracteristicaPlan: string; // viene "21", "ND" → string, no número
  minimo: number | null;
  cobertura: number | null;
  puntoPedido: number | null;
  stockObjetivo: number | null;
}

const StockCedisSchema = new Schema<IStockCedis>(
  {
    uploadId: { type: Schema.Types.ObjectId, ref: "Upload", required: true },
    cuenta: { type: String, required: true },
    fechaCorte: { type: Date, required: true },
    sku: { type: String, required: true },
    descripcion: { type: String, default: "" },
    marca: { type: String, default: "SIN CLASIFICAR" },
    division: { type: String, default: "" },
    numProveedor: { type: String, default: "" },
    proveedor: { type: String, default: "" },
    disponibilidadRealCD: { type: Number, default: null },
    transitos: { type: Number, default: null },
    sinCita: { type: Number, default: null },
    citas: {
      type: [
        new Schema<ICitaCedis>(
          {
            fecha: { type: Date, required: true },
            cantidad: { type: Number, required: true },
          },
          { _id: false }
        ),
      ],
      default: [],
    },
    caracteristicaPlan: { type: String, default: "" },
    minimo: { type: Number, default: null },
    cobertura: { type: Number, default: null },
    puntoPedido: { type: Number, default: null },
    stockObjetivo: { type: Number, default: null },
  },
  { versionKey: false }
);

StockCedisSchema.index({ cuenta: 1, fechaCorte: -1, sku: 1 });
StockCedisSchema.index({ uploadId: 1 });

export const StockCedis: Model<IStockCedis> =
  (models.StockCedis as Model<IStockCedis>) ??
  model<IStockCedis>("StockCedis", StockCedisSchema);
