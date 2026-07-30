import { Schema, model, models, type Model, type Types } from "mongoose";

// Hoja VENTAS en formato largo (unpivot §6.1): un documento por
// tienda × SKU × fecha. Habilita el histórico y el comparativo año contra año.
export interface IVentaDiaria {
  _id: Types.ObjectId;
  uploadId: Types.ObjectId;
  cuenta: string;
  fechaCorte: Date;
  fecha: Date;
  codigoTienda: string; // "0141", nunca número
  nombreTienda: string;
  sku: string;
  idCompuesto: string; // codigoTienda + sku
  descripcion: string;
  marca: string; // derivada (lib/retail/brands.ts)
  division: string;
  numProveedor: string;
  proveedor: string;
  unidades: number;
}

const VentaDiariaSchema = new Schema<IVentaDiaria>(
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
    unidades: { type: Number, required: true },
  },
  { versionKey: false }
);

VentaDiariaSchema.index({ cuenta: 1, fecha: -1, sku: 1 });
VentaDiariaSchema.index({ uploadId: 1 });
VentaDiariaSchema.index({ cuenta: 1, marca: 1, fecha: -1 });

export const VentaDiaria: Model<IVentaDiaria> =
  (models.VentaDiaria as Model<IVentaDiaria>) ??
  model<IVentaDiaria>("VentaDiaria", VentaDiariaSchema);
