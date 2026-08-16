import { z } from "zod";
import { XLSX_CONTENT_TYPE } from "@/lib/retail/archivos";
import { RETAILER_IDS } from "@/lib/retail/retailers";

// v1: solo San Pablo. El modelo queda preparado para múltiples cuentas,
// pero no existe fuente de datos de Walmart todavía (§0).
export const CUENTAS = ["san-pablo"] as const;
export type Cuenta = (typeof CUENTAS)[number];

export const MAX_XLSX_BYTES = 25 * 1024 * 1024; // 25 MB (§5.7)

export const HOJAS = [
  "CEDIS",
  "VENTAS",
  "PRONOSTICOS",
  "FC_Mean",
  "Fill Rate",
  "Inv Farma",
] as const;
export type Hoja = (typeof HOJAS)[number];

const fechaISO = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Formato de fecha: YYYY-MM-DD");

// --- Cargas -----------------------------------------------------------

export const createUploadSchema = z.object({
  filename: z
    .string()
    .min(1)
    .max(200)
    .refine((f) => f.toLowerCase().endsWith(".xlsx"), "Solo se aceptan archivos .xlsx"),
  contentType: z.literal(XLSX_CONTENT_TYPE, {
    error: "El archivo debe ser un Excel .xlsx",
  }),
  sizeBytes: z
    .number()
    .int()
    .positive()
    .max(MAX_XLSX_BYTES, "El archivo supera el máximo de 25 MB"),
  account: z.enum(CUENTAS).default("san-pablo"),
});

export const processUploadSchema = z.object({
  cutoffDate: fechaISO,
});

export const uploadsQuerySchema = z.object({
  account: z.enum(CUENTAS).optional(),
  buscar: z.string().max(120).optional(),
  status: z.enum(["pending", "processing", "processed", "error"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const rowsQuerySchema = z.object({
  sheet: z.enum(HOJAS),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  buscar: z.string().max(120).optional(),
  tienda: z.string().max(60).optional(),
  brand: z.string().max(60).optional(),
  sku: z.string().max(30).optional(),
  orden: z.string().max(40).optional(),
  dir: z.enum(["asc", "desc"]).default("desc"),
});

export const scorecardQuerySchema = z.object({
  account: z.enum(CUENTAS).default("san-pablo"),
  hasta: fechaISO.optional(),
});

export const historicoQuerySchema = z.object({
  account: z.enum(CUENTAS).default("san-pablo"),
  desde: fechaISO.optional(),
  hasta: fechaISO.optional(),
});

// --- Filas del parser (§7.5) ------------------------------------------
// toNumber ya trató "", null, "ND", "-" como null (un cero y un dato
// ausente NO son lo mismo). Aquí se valida la forma final del documento.

const storeCode = z.string().regex(/^\d{4}$/, "Código de tienda de 4 dígitos");
const sku = z.string().regex(/^\d+$/, "SKU numérico como string");
const numeroNullable = z.number().finite().nullable();

export const ventaRowSchema = z.object({
  date: z.date(),
  storeCode,
  storeName: z.string(),
  sku,
  compositeId: z.string(),
  description: z.string(),
  brand: z.string(),
  division: z.string(),
  vendorCode: z.string(),
  vendorName: z.string(),
  units: z.number().finite(),
});

export const pronosticoRowSchema = ventaRowSchema
  .omit({ date: true, units: true })
  .extend({ weekStart: z.date(), value: z.number().finite() });

export const forecastRowSchema = ventaRowSchema
  .omit({ units: true })
  .extend({ value: z.number().finite() });

export const cedisRowSchema = z.object({
  sku,
  description: z.string(),
  brand: z.string(),
  division: z.string(),
  vendorCode: z.string(),
  vendorName: z.string(),
  realAvailabilityDC: numeroNullable,
  inTransit: numeroNullable,
  withoutAppointment: numeroNullable,
  appointments: z.array(z.object({ date: z.date(), quantity: z.number().finite() })),
  planCharacteristic: z.string(), // viene "21" y "ND" → string, no número
  minimum: numeroNullable,
  coverage: numeroNullable,
  reorderPoint: numeroNullable,
  targetStock: numeroNullable,
});

export const farmaciaRowSchema = z.object({
  compositeId: z.string(),
  storeCode,
  storeName: z.string(),
  sku,
  description: z.string(),
  brand: z.string(),
  division: z.string(),
  vendorCode: z.string(),
  vendorName: z.string(),
  itemType: z.string(),
  abc: z.string(),
  sm: z.string(),
  cap: z.string(),
  minSafetyStock: numeroNullable,
  minTargetCoverage: numeroNullable,
  targetStock: numeroNullable,
  reorderPoint: numeroNullable,
  dynamicStock: numeroNullable,
  maxStock: numeroNullable,
  unrestrictedStock: numeroNullable,
  pharmacyInTransit: numeroNullable,
  sellingClass: numeroNullable,
  inventoryLevel: numeroNullable,
});

export const lineaOcRowSchema = z.object({
  purchaseDoc: z.string().min(1),
  lineNumber: numeroNullable,
  vendorCode: z.string(),
  vendorName: z.string(),
  sku,
  description: z.string(),
  brand: z.string(),
  division: z.string(),
  orderDate: z.date().nullable(),
  allocatedQty: numeroNullable,
  uom: z.string(),
  deliveredQty: numeroNullable,
  deliveryDate: z.date().nullable(),
  fillRate: numeroNullable, // fracción: 1 = 100%
  poStatus: z.string(),
  buyer: z.string(),
  orderInUMA: numeroNullable,
  purchaseDocRef: z.string(),
  cpfr: z.string(),
});

// --- Analizador ad-hoc (§7 bis) ---------------------------------------

// Filas que el analizador manda al histórico. El cliente ya reconoció la
// plantilla y mapeó los encabezados a campos, así que aquí se valida la forma
// final, no el Excel.
export const reporteVentaRowSchema = z.object({
  // ISO local YYYY-MM-DD; el servidor la ancla a medianoche UTC.
  date: fechaISO,
  wmMonth: z.string().max(20),
  brand: z.string().max(200),
  itemDesc: z.string().max(300),
  itemNbr: z.number().int().finite(),
  primeItemNbr: z.number().int().finite(),
  // Texto, no número: el UPC trae cero a la izquierda.
  upc: z.string().max(40),
  productCode: z.string().max(40),
  posQty: z.number().finite(),
  posSales: z.number().finite(),
  avgPrice: z.number().finite(),
  avgSalesPerStore: z.number().finite(),
  itemQtySold: z.number().finite(),
  basketOccurrences: z.number().finite(),
});

export type ReporteVentaRow = z.infer<typeof reporteVentaRowSchema>;

// Se envía por lotes: 15 mil filas en un solo POST son varios MB y no dan
// señal de avance. El cliente trocea y el servidor hace upsert de cada lote.
export const MAX_FILAS_LOTE = 2000;

export const guardarAnalisisSchema = z.object({
  template: z.string().min(1).max(60),
  // El retailer lo elige la persona antes de guardar, no lo deduce la
  // plantilla: un mismo layout puede llegar de más de una cuenta, y ese dato es
  // el que separa los reportes en el histórico. Enum y no string libre para que
  // un id mal escrito no cree una cuenta fantasma imposible de encontrar.
  account: z.enum(RETAILER_IDS, { error: "Selecciona un retailer válido" }),
  sourceFile: z.string().min(1).max(300),
  filas: z.array(reporteVentaRowSchema).min(1).max(MAX_FILAS_LOTE),
});

export const historicoAnalisisQuerySchema = z.object({
  account: z.enum(RETAILER_IDS).optional(),
});

// La tabla del histórico pagina en el servidor: nunca se bajan 15 mil filas al
// navegador sólo para entrar a la pestaña. `limit` tope 100 es el tamaño de
// página que pide la UI; `sourceFile` ausente significa "el último cargado".
export const FILAS_POR_PAGINA = 100;

// KPIs y gráficas del histórico: Mongo agrega y el navegador pliega.
//
// Antes se bajaba el reporte completo para correr las mismas agregaciones en el
// navegador que un archivo recién subido. Se midió y no sale: 15,344 filas son
// 5.2 MB y el enlace a la base sostiene ~110 KB/s, o sea 48 s por entrar a la
// pestaña.
//
// Pero agregar en el servidor PARA UNA SELECCIÓN concreta tampoco sale: cada
// cambio de métrica costaba un viaje, y se veía el KPI cambiar de etiqueta
// antes que de valor. Así que la ruta no recibe qué agregar: devuelve los
// acumuladores de todas las métricas y todas las dimensiones de una vez
// (~50 KB, un `$facet`) y el cliente elige sin volver a preguntar.
//
// La serie diaria (735 buckets, 205 KB) queda fuera del bundle y se pide con
// `parte=serie&granularidad=dia` la primera vez que alguien la elige.
export const METRICA_CONTEO_ID = "__conteo__";

export const resumenAnalisisQuerySchema = z.object({
  account: z.enum(RETAILER_IDS).optional(),
  sourceFile: z.string().min(1).max(300).optional(),
  parte: z.enum(["bundle", "serie"]).default("bundle"),
  granularidad: z.enum(["dia", "mes", "anio"]).optional(),
});

export const filasAnalisisQuerySchema = z.object({
  account: z.enum(RETAILER_IDS).optional(),
  sourceFile: z.string().min(1).max(300).optional(),
  buscar: z.string().max(120).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(FILAS_POR_PAGINA).default(FILAS_POR_PAGINA),
});
