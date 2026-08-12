import { Schema, model, models, type Model, type Types } from "mongoose";

// Hoja FC_Mean (unpivot). Excluye "Total" y "Total red": los totales se
// recalculan al consultar, nunca se cachean del Excel (§7.2).
export interface IForecastDiario {
  _id: Types.ObjectId;
  uploadId: Types.ObjectId;
  cuenta: string;
  fechaCorte: Date;
  fecha: Date;
  codigoTienda: string;
  nombreTienda: string;
  sku: string;
  idCompuesto: string;
  descripcion: string;
  marca: string;
  division: string;
  numProveedor: string;
  proveedor: string;
  valor: number;
}

const ForecastDiarioSchema = new Schema<IForecastDiario>(
  {
    uploadId: { type: Schema.Types.ObjectId, ref: "Upload", required: true },
    cuenta: { type: String, required: true },
    fechaCorte: { type: Date, required: true },
    fecha: { type: Date, required: true },
    codigoTienda: { type: String, required: true },
    nombreTienda: { type: String, default: "" },
    sku: { type: String, required: true },
    idCompuesto: { type: String, default: "" },
    descripcion: { type: String, default: "" },
    marca: { type: String, default: "SIN CLASIFICAR" },
    division: { type: String, default: "" },
    numProveedor: { type: String, default: "" },
    proveedor: { type: String, default: "" },
    valor: { type: Number, required: true },
  },
  { versionKey: false }
);

ForecastDiarioSchema.index({ cuenta: 1, fecha: -1, sku: 1 });
ForecastDiarioSchema.index({ uploadId: 1 });

export const ForecastDiario: Model<IForecastDiario> =
  (models.ForecastDiario as Model<IForecastDiario>) ??
  model<IForecastDiario>("ForecastDiario", ForecastDiarioSchema);
