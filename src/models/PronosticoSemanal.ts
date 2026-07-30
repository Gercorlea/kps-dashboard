import { Schema, model, models, type Model, type Types } from "mongoose";

// Hoja PRONOSTICOS (unpivot): un documento por tienda × SKU × semana.
export interface IPronosticoSemanal {
  _id: Types.ObjectId;
  uploadId: Types.ObjectId;
  cuenta: string;
  fechaCorte: Date;
  semanaInicio: Date;
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

const PronosticoSemanalSchema = new Schema<IPronosticoSemanal>(
  {
    uploadId: { type: Schema.Types.ObjectId, ref: "Upload", required: true },
    cuenta: { type: String, required: true },
    fechaCorte: { type: Date, required: true },
    semanaInicio: { type: Date, required: true },
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

PronosticoSemanalSchema.index({ cuenta: 1, semanaInicio: -1, sku: 1 });
PronosticoSemanalSchema.index({ uploadId: 1 });

export const PronosticoSemanal: Model<IPronosticoSemanal> =
  (models.PronosticoSemanal as Model<IPronosticoSemanal>) ??
  model<IPronosticoSemanal>("PronosticoSemanal", PronosticoSemanalSchema);
