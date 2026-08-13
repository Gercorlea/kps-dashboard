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
  r2Key: string; // private/retail/<uploadId>/<filename>
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
    r2Key: { type: String, required: true },
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

// sparse: fileHash es null hasta que la carga se procesa
UploadSchema.index({ fileHash: 1 }, { unique: true, sparse: true });
UploadSchema.index({ account: 1, cutoffDate: -1 });
UploadSchema.index({ status: 1 });

export const Upload: Model<IUpload> =
  (models.Upload as Model<IUpload>) ?? model<IUpload>("Upload", UploadSchema);
