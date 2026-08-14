import { Schema, model, models, type Model, type Types } from "mongoose";

export type UploadStatus = "pending" | "processing" | "processed" | "error";

export interface IIncidencia {
  sheet: string;
  row?: number;
  field?: string;
  message: string;
}

export interface IResumenHoja {
  read: number;
  inserted: number;
  rejected: number;
}

// Una por archivo subido (§6.2).
export interface IUpload {
  _id: Types.ObjectId;
  filename: string;
  fileHash: string | null; // sha256; único → evita doble carga (se calcula al procesar)
  sizeBytes: number;
  account: string; // "san-pablo" (v1). Preparado para "walmart"
  cutoffDate: Date; // derivada del nombre; editable antes de procesar
  status: UploadStatus;
  detectedSheets: string[];
  summary: Record<string, IResumenHoja>;
  issues: IIncidencia[];
  uploadedBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
  processedAt: Date | null;
}

const UploadSchema = new Schema<IUpload>(
  {
    filename: { type: String, required: true },
    fileHash: { type: String, default: null },
    sizeBytes: { type: Number, required: true },
    account: { type: String, required: true, default: "san-pablo" },
    cutoffDate: { type: Date, required: true },
    status: {
      type: String,
      enum: ["pending", "processing", "processed", "error"],
      default: "pending",
    },
    detectedSheets: { type: [String], default: [] },
    summary: { type: Schema.Types.Mixed, default: {} },
    issues: {
      type: [
        new Schema<IIncidencia>(
          {
            sheet: { type: String, required: true },
            row: { type: Number },
            field: { type: String },
            message: { type: String, required: true },
          },
          { _id: false }
        ),
      ],
      default: [],
    },
    uploadedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    processedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// fileHash es null hasta que la carga se procesa. `sparse` NO sirve aquí:
// solo excluye documentos donde el campo está AUSENTE, y `default: null`
// escribe un null explícito en cada carga nueva, así que dos cargas pendientes
// chocaban con E11000 dup key { fileHash: null }. El índice parcial solo
// indexa las cargas ya procesadas (hash string) y deja convivir N pendientes.
// Si cambias esto hay que borrar y recrear el índice a mano en cada base ya
// existente: Mongoose nunca altera las opciones de un índice que ya existe.
UploadSchema.index(
  { fileHash: 1 },
  { unique: true, partialFilterExpression: { fileHash: { $type: "string" } } }
);
UploadSchema.index({ account: 1, cutoffDate: -1 });
UploadSchema.index({ status: 1 });

export const Upload: Model<IUpload> =
  (models.Upload as Model<IUpload>) ?? model<IUpload>("Upload", UploadSchema);
