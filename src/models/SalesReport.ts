import { Schema, model, models, type Model, type Types } from "mongoose";

// Histórico acumulado de los reportes de venta que se analizan en
// /retail/analisis. Un documento por artículo × día — el grano del reporte
// mensual de Walmart, donde (itemNbr, date) es única.
//
// A diferencia de DailySale, que nace del flujo de ingesta con hojas fijas,
// esta colección se llena desde el analizador: guarda sólo las columnas
// importantes de la plantilla reconocida y deja fuera las constantes.
export interface ISalesReport {
  _id: Types.ObjectId;

  // Procedencia: de qué plantilla salió la fila y en qué archivos aparece.
  template: string; // "walmart-mensual"
  account: string; // "walmart"

  /**
   * Archivos que CONTIENEN esta fila, no "el archivo que la trajo".
   *
   * La clave natural no incluye el archivo, así que dos reportes que se solapan
   * —feb-mar y luego mar-abr— comparten las filas de marzo. Con un escalar, el
   * segundo se las quitaba al primero: la pertenencia es de muchos a muchos y
   * estaba modelada como uno a uno. Se acumula con $addToSet, de modo que el
   * registro compartido aparece en los dos reportes SIN duplicarse en la
   * colección ni en ninguna agregación por cuenta.
   *
   * Una fila que se queda sin ningún archivo (se borró el último que la tenía)
   * ya no la reclama nadie y se elimina; ver el DELETE de
   * /api/retail/analisis/reporte.
   */
  sourceFiles: string[];

  /**
   * Última escritura de la fila. Se sobrescribe cada vez que una carga la toca,
   * sea el mismo reporte al volver a subirse o uno que se solapa con él.
   *
   * Cuándo se importó un REPORTE no se deduce de aquí: vive en su propio
   * documento (models/ReportImport.ts). Éste sólo fecha la fila.
   */
  importedAt: Date;
  importedBy: Types.ObjectId;

  // Fecha y periodo. `wmMonth` es el mes FISCAL de Walmart y no siempre
  // coincide con el mes calendario de `date`, así que se guardan los dos.
  date: Date; // medianoche UTC, como el resto de retail (fechaISO)
  wmMonth: string; // "2026/05"

  // Dimensiones y códigos. `upc` es texto porque trae cero a la izquierda
  // ("0750229353070"); pasarlo por Number() lo perdería.
  brand: string;
  itemDesc: string;
  itemNbr: number;
  primeItemNbr: number;
  upc: string;
  productCode: string;

  // Métricas.
  posQty: number;
  posSales: number;
  avgPrice: number;
  avgSalesPerStore: number;
  itemQtySold: number;
  basketOccurrences: number;
}

const SalesReportSchema = new Schema<ISalesReport>(
  {
    template: { type: String, required: true },
    account: { type: String, required: true },
    sourceFiles: { type: [String], default: [] },
    importedAt: { type: Date, required: true },
    importedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },

    date: { type: Date, required: true },
    wmMonth: { type: String, default: "" },

    brand: { type: String, default: "" },
    itemDesc: { type: String, default: "" },
    itemNbr: { type: Number, required: true },
    primeItemNbr: { type: Number, default: 0 },
    upc: { type: String, default: "" },
    productCode: { type: String, default: "" },

    posQty: { type: Number, default: 0 },
    posSales: { type: Number, default: 0 },
    avgPrice: { type: Number, default: 0 },
    avgSalesPerStore: { type: Number, default: 0 },
    itemQtySold: { type: Number, default: 0 },
    basketOccurrences: { type: Number, default: 0 },
  },
  { versionKey: false }
);

// Clave natural del grano. Es lo que hace que volver a subir el mismo reporte
// ACTUALICE en vez de duplicar: sin esto el histórico se infla en cada carga.
// Y es también lo que garantiza que compartir una fila entre dos archivos no
// pueda duplicarla: la procedencia está fuera de la clave a propósito.
SalesReportSchema.index({ account: 1, itemNbr: 1, date: 1 }, { unique: true });
SalesReportSchema.index({ account: 1, date: -1 });
SalesReportSchema.index({ account: 1, brand: 1, date: -1 });

// Todo lo que mira UN reporte: la tabla de /retail/analisis, el bundle con
// alcance=archivo y la ficha del reporte.
//
// Es multikey porque `sourceFiles` es un arreglo — el único de la clave
// compuesta, que es lo que Mongo permite. Sirve igual para la igualdad por
// contención ({ sourceFiles: "x.xlsx" }), mantiene el orden total (date,
// itemNbr) que necesita el paginado de la tabla —sin un orden total, dos filas
// empatadas pueden salir en las páginas 1 y 2 a la vez, o en ninguna— y con
// `account` al frente cubre además el $unwind que cuenta filas por archivo.
SalesReportSchema.index({ account: 1, sourceFiles: 1, date: 1, itemNbr: 1 });

// Resolver "la última fila escrita" es un solo findOne ordenado por esto.
SalesReportSchema.index({ importedAt: -1 });

export const SalesReport: Model<ISalesReport> =
  (models.SalesReport as Model<ISalesReport>) ??
  model<ISalesReport>("SalesReport", SalesReportSchema);
