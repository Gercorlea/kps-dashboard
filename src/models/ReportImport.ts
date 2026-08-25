import { Schema, model, models, type Model, type Types } from "mongoose";

// Un documento por reporte guardado: (account, sourceFile).
//
// Las fechas de un reporte son del REPORTE, no de sus filas, y hasta ahora se
// deducían de ellas. Podía hacerse mientras cada fila pertenecía a un solo
// archivo, pero costaba caro y no siempre salía bien: dos reportes que se
// solapan comparten filas, y el que las tiene hoy no es necesariamente el que
// las trajo. De ahí venían `firstSourceFile` y las heurísticas de atribución
// que vivían en lib/retail/importaciones.ts.
//
// Con la procedencia guardada como CONJUNTO en la fila (SalesReport.sourceFiles)
// ningún archivo pierde filas, así que la pregunta "¿qué carga creó esta fila?"
// deja de tener uso y el dato puede vivir donde le toca. La lista de "Reportes
// guardados" pasa a ser un find sobre unas decenas de documentos en vez de una
// agregación sobre las ~15,000 filas de la cuenta.
export interface IReportImport {
  _id: Types.ObjectId;

  account: string; // "walmart"
  sourceFile: string; // "Reporte mensual Walmart 05082026.xlsx"
  template: string; // "walmart-mensual"

  /** Primera vez que se subió; no se mueve al volver a subirlo. */
  importedAt: Date;
  importedBy: Types.ObjectId;

  /** Última re-subida; null mientras el reporte no se haya vuelto a subir. */
  reimportedAt: Date | null;
  reimportedBy: Types.ObjectId | null;

  /**
   * Id de la carga que escribió por última vez.
   *
   * Una carga viaja en lotes de 2000 filas (MAX_FILAS_LOTE) y cada lote es un
   * POST independiente. Sin esto, el segundo lote de la PRIMERA subida vería un
   * documento ya existente y marcaría el reporte como actualizado el mismo día
   * en que se importó. El cliente manda el mismo valor en todos los lotes de
   * una subida, así que "el documento lo dejó otra carga" es exactamente "el
   * reporte se volvió a subir".
   */
  loadId: string;

  /** Cualquier escritura, primera o no. Es lo que ordena la lista de reportes. */
  lastWriteAt: Date;
}

const ReportImportSchema = new Schema<IReportImport>(
  {
    account: { type: String, required: true },
    sourceFile: { type: String, required: true },
    template: { type: String, required: true },

    importedAt: { type: Date, required: true },
    importedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },

    // `default: null` y no ausente: la ficha distingue "nunca se actualizó" de
    // "no se sabe", y así el campo se puede filtrar con la misma consulta esté
    // o no puesto.
    reimportedAt: { type: Date, default: null },
    reimportedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },

    loadId: { type: String, required: true },
    lastWriteAt: { type: Date, required: true },
  },
  { versionKey: false }
);

// La identidad del reporte, y lo que hace atómica el alta cuando dos lotes de
// la misma carga llegan a la vez: el upsert del POST se apoya en este índice
// para que sólo uno inserte.
ReportImportSchema.index({ account: 1, sourceFile: 1 }, { unique: true });
// La lista de un retailer: el reporte tocado más recientemente va primero.
ReportImportSchema.index({ account: 1, lastWriteAt: -1 });
// "El último reporte cargado" —lo que abre /retail/analisis sin `sourceFile` y
// lo que la ficha del retailer muestra en la cabecera— es un findOne por esto.
ReportImportSchema.index({ account: 1, importedAt: -1 });

export const ReportImport: Model<IReportImport> =
  (models.ReportImport as Model<IReportImport>) ??
  model<IReportImport>("ReportImport", ReportImportSchema);
