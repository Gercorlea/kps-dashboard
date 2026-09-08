import { Schema, model, models, type Model, type Types } from "mongoose";

/**
 * Estados de una carga del catálogo.
 *
 * - `loading`   filas escritas pero INVISIBLES; nadie las lee todavía.
 * - `active`    la carga que el módulo muestra. Sólo debería haber una.
 * - `replaced`  la sustituyó una carga posterior; sus filas se borran.
 * - `failed`    se abandonó o llegó incompleta; sus filas se borran.
 */
export type CatalogLoadStatus = "loading" | "active" | "replaced" | "failed";

/** Aviso o error de una fila/columna concreta del Excel, para poder corregirlo. */
export interface ICatalogIssue {
  sheet: string;
  row?: number;
  field?: string;
  message: string;
  severity: "error" | "aviso" | "info";
}

// Una por SUBIDA. Es el documento que decide qué ve el módulo: todas las
// lecturas resuelven primero la carga activa y filtran por su loadId.
//
// Cada carga reemplaza por completo a la anterior, así que hace falta saber
// siempre QUÉ archivo se está viendo, quién lo subió y cuándo: sin eso, un
// reemplazo total es indistinguible de que los datos hayan cambiado solos.
export interface ICatalogLoad {
  _id: Types.ObjectId;
  /** uuid generado en el SERVIDOR; ver POST /api/catalogo/cargas. */
  loadId: string;
  status: CatalogLoadStatus;

  filename: string;
  sizeBytes: number;
  /** Hojas de las que se leyó cada cosa, para poder explicar una carga rara. */
  productSheet: string;
  mappingSheet: string | null;

  /**
   * Lo que el cliente dijo que iba a mandar, y lo que realmente quedó escrito.
   * Si no coinciden, un lote se perdió por el camino y la carga NO se activa:
   * un catálogo a medias es peor que no haber subido nada.
   */
  declaredProducts: number;
  declaredMappings: number;
  productCount: number;
  mappingCount: number;

  /** Filas que el lector tiró por venirle sin un campo obligatorio. */
  discardedProducts: number;
  discardedMappings: number;
  /** skus de la hoja 2 sin Item en la hoja 1; se cuenta al finalizar. */
  orphanMappings: number;

  issues: ICatalogIssue[];

  uploadedBy: Types.ObjectId;
  uploadedAt: Date;
  finalizedAt: Date | null;
  replacedAt: Date | null;
  /** Carga que ésta reemplazó; para la línea "reemplazó el archivo X". */
  replacedLoadId: string | null;
}

const CatalogIssueSchema = new Schema<ICatalogIssue>(
  {
    sheet: { type: String, default: "" },
    row: { type: Number },
    field: { type: String },
    message: { type: String, required: true },
    severity: { type: String, enum: ["error", "aviso", "info"], default: "info" },
  },
  { _id: false, versionKey: false }
);

const CatalogLoadSchema = new Schema<ICatalogLoad>(
  {
    loadId: { type: String, required: true },
    status: {
      type: String,
      enum: ["loading", "active", "replaced", "failed"],
      required: true,
      default: "loading",
    },

    filename: { type: String, required: true },
    sizeBytes: { type: Number, default: 0 },
    productSheet: { type: String, default: "" },
    mappingSheet: { type: String, default: null },

    declaredProducts: { type: Number, default: 0 },
    declaredMappings: { type: Number, default: 0 },
    productCount: { type: Number, default: 0 },
    mappingCount: { type: Number, default: 0 },
    discardedProducts: { type: Number, default: 0 },
    discardedMappings: { type: Number, default: 0 },
    orphanMappings: { type: Number, default: 0 },

    issues: { type: [CatalogIssueSchema], default: [] },

    uploadedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    uploadedAt: { type: Date, required: true },
    finalizedAt: { type: Date, default: null },
    replacedAt: { type: Date, default: null },
    replacedLoadId: { type: String, default: null },
  },
  { versionKey: false }
);

CatalogLoadSchema.index({ loadId: 1 }, { unique: true });

// "La carga activa" es un findOne por este índice, y ocurre en TODA petición de
// lectura del módulo.
//
// Se descartó un índice único parcial que impusiera "una sola carga activa"
// como invariante de base (el patrón de Upload.fileHash): obligaría a desactivar
// la vieja ANTES de activar la nueva, y entre las dos escrituras el módulo no
// tendría carga activa —si la segunda falla, el catálogo se queda en blanco—.
// Ordenando por finalizedAt conviven dos activas unos milisegundos y la lectura
// toma la más nueva: correcto, y nunca vacío.
CatalogLoadSchema.index({ status: 1, finalizedAt: -1 });

// El barrido de cargas abandonadas ("loading" viejas) y de las ya reemplazadas.
CatalogLoadSchema.index({ status: 1, uploadedAt: 1 });

export const CatalogLoad: Model<ICatalogLoad> =
  (models.CatalogLoad as Model<ICatalogLoad>) ??
  model<ICatalogLoad>("CatalogLoad", CatalogLoadSchema);
