import { Schema, model, models, type Model, type Types } from "mongoose";

// Hoja "Fill Rate": una línea por posición de orden de compra (§6.2).
export interface ILineaOC {
  _id: Types.ObjectId;
  uploadId: Types.ObjectId;
  cuenta: string;
  fechaCorte: Date;
  documentoCompras: string;
  posicion: number | null;
  numProveedor: string;
  nombreProveedor: string;
  sku: string;
  descripcion: string;
  marca: string;
  division: string;
  fechaPedido: Date | null;
  cantidadReparto: number | null;
  unidadMedida: string;
  cantidadEntregada: number | null;
  fechaEntrega: Date | null;
  fillRate: number | null; // fracción: 1 = 100% (§7.5)
  estatusOC: string;
  negociador: string;
  pedidoEnUMA: number | null;
  ciDoctoCompras: string;
  cpfr: string;
}

const LineaOCSchema = new Schema<ILineaOC>(
  {
    uploadId: { type: Schema.Types.ObjectId, ref: "Upload", required: true },
    cuenta: { type: String, required: true },
    fechaCorte: { type: Date, required: true },
    documentoCompras: { type: String, required: true },
    posicion: { type: Number, default: null },
    numProveedor: { type: String, default: "" },
    nombreProveedor: { type: String, default: "" },
    sku: { type: String, required: true },
    descripcion: { type: String, default: "" },
    marca: { type: String, default: "SIN CLASIFICAR" },
    division: { type: String, default: "" },
    fechaPedido: { type: Date, default: null },
    cantidadReparto: { type: Number, default: null },
    unidadMedida: { type: String, default: "" },
    cantidadEntregada: { type: Number, default: null },
    fechaEntrega: { type: Date, default: null },
    fillRate: { type: Number, default: null },
    estatusOC: { type: String, default: "" },
    negociador: { type: String, default: "" },
    pedidoEnUMA: { type: Number, default: null },
    ciDoctoCompras: { type: String, default: "" },
    cpfr: { type: String, default: "" },
  },
  { versionKey: false }
);

LineaOCSchema.index({ cuenta: 1, fechaCorte: -1 });
LineaOCSchema.index({ uploadId: 1 });
LineaOCSchema.index({ cuenta: 1, fechaCorte: -1, negociador: 1 });

export const LineaOC: Model<ILineaOC> =
  (models.LineaOC as Model<ILineaOC>) ?? model<ILineaOC>("LineaOC", LineaOCSchema);
