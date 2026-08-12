import { Schema, model, models, type Model, type Types } from "mongoose";

export type UploadStatus = "pendiente" | "procesando" | "procesado" | "error";

export interface IIncidencia {
  hoja: string;
  fila?: number;
  campo?: string;
  mensaje: string;
}

export interface IResumenHoja {
  leidas: number;
  insertadas: number;
  rechazadas: number;
}

// Una por archivo subido (§6.2).
export interface IUpload {
  _id: Types.ObjectId;
  filename: string;
  fileHash: string | null; // sha256; único → evita doble carga (se calcula al procesar)
  r2Key: string; // private/retail/<uploadId>/<filename>
  sizeBytes: number;
  cuenta: string; // "san-pablo" (v1). Preparado para "walmart"
  fechaCorte: Date; // derivada del nombre; editable antes de procesar
  status: UploadStatus;
  hojasDetectadas: string[];
  resumen: Record<string, IResumenHoja>;
  incidencias: IIncidencia[];
  subidoPor: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
  processedAt: Date | null;
}

const UploadSchema = new Schema<IUpload>(
  {
    filename: { type: String, required: true },
    fileHash: { type: String, default: null },
    r2Key: { type: String, required: true },
    sizeBytes: { type: Number, required: true },
    cuenta: { type: String, required: true, default: "san-pablo" },
    fechaCorte: { type: Date, required: true },
    status: {
      type: String,
      enum: ["pendiente", "procesando", "procesado", "error"],
      default: "pendiente",
    },
    hojasDetectadas: { type: [String], default: [] },
    resumen: { type: Schema.Types.Mixed, default: {} },
    incidencias: {
      type: [
        new Schema<IIncidencia>(
          {
            hoja: { type: String, required: true },
            fila: { type: Number },
            campo: { type: String },
            mensaje: { type: String, required: true },
          },
          { _id: false }
        ),
      ],
      default: [],
    },
    subidoPor: { type: Schema.Types.ObjectId, ref: "User", required: true },
    processedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// sparse: fileHash es null hasta que la carga se procesa
UploadSchema.index({ fileHash: 1 }, { unique: true, sparse: true });
UploadSchema.index({ cuenta: 1, fechaCorte: -1 });
UploadSchema.index({ status: 1 });

export const Upload: Model<IUpload> =
  (models.Upload as Model<IUpload>) ?? model<IUpload>("Upload", UploadSchema);
