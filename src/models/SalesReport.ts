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

  // Procedencia: de qué archivo y plantilla salió cada fila.
  template: string; // "walmart-mensual"
  account: string; // "walmart"
  sourceFile: string;
  /** Última escritura de la fila: se sobrescribe si el reporte se vuelve a subir. */
  importedAt: Date;
  importedBy: Types.ObjectId;

  // Primera escritura de la fila, y quién la hizo. Van aparte porque el upsert
  // por la clave natural sobrescribe `importedAt`/`importedBy` cada vez que se
  // vuelve a subir el mismo reporte: sin estos dos campos la fecha en que se
  // importó por primera vez se perdía, y la ficha del retailer no podía
  // distinguir "importado el" de "última actualización".
  //
  // Opcionales porque las filas guardadas antes de que existieran no los
  // tienen; quien los lea cae a `importedAt`/`importedBy` con $ifNull.
  firstImportedAt?: Date;
  firstImportedBy?: Types.ObjectId;

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
    sourceFile: { type: String, default: "" },
    importedAt: { type: Date, required: true },
    importedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    // Sin `default`: lo escribe el $setOnInsert del POST, y un default de
    // esquema se le adelantaría en el upsert.
    firstImportedAt: { type: Date },
    firstImportedBy: { type: Schema.Types.ObjectId, ref: "User" },

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
SalesReportSchema.index({ account: 1, itemNbr: 1, date: 1 }, { unique: true });
SalesReportSchema.index({ account: 1, date: -1 });
SalesReportSchema.index({ account: 1, brand: 1, date: -1 });

// La tabla de /retail/analisis lista un archivo a la vez, ordenado por
// (date, itemNbr) para que el paginado sea estable: sin un orden total, dos
// filas empatadas pueden salir en las páginas 1 y 2 a la vez, o en ninguna.
SalesReportSchema.index({ sourceFile: 1, date: 1, itemNbr: 1 });
// Resolver "el último Excel cargado" es un solo findOne ordenado por esto.
SalesReportSchema.index({ importedAt: -1 });

export const SalesReport: Model<ISalesReport> =
  (models.SalesReport as Model<ISalesReport>) ??
  model<ISalesReport>("SalesReport", SalesReportSchema);
