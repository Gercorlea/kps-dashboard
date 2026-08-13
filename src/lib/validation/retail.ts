import { z } from "zod";
import { XLSX_CONTENT_TYPE } from "@/lib/r2";

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
