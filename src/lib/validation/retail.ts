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
  cuenta: z.enum(CUENTAS).default("san-pablo"),
});

export const processUploadSchema = z.object({
  fechaCorte: fechaISO,
});

export const uploadsQuerySchema = z.object({
  cuenta: z.enum(CUENTAS).optional(),
  buscar: z.string().max(120).optional(),
  status: z.enum(["pendiente", "procesando", "procesado", "error"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const rowsQuerySchema = z.object({
  hoja: z.enum(HOJAS),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  buscar: z.string().max(120).optional(),
  tienda: z.string().max(60).optional(),
  marca: z.string().max(60).optional(),
  sku: z.string().max(30).optional(),
  orden: z.string().max(40).optional(),
  dir: z.enum(["asc", "desc"]).default("desc"),
});

export const scorecardQuerySchema = z.object({
  cuenta: z.enum(CUENTAS).default("san-pablo"),
  hasta: fechaISO.optional(),
});

export const historicoQuerySchema = z.object({
  cuenta: z.enum(CUENTAS).default("san-pablo"),
  desde: fechaISO.optional(),
  hasta: fechaISO.optional(),
});

// --- Filas del parser (§7.5) ------------------------------------------
// toNumber ya trató "", null, "ND", "-" como null (un cero y un dato
// ausente NO son lo mismo). Aquí se valida la forma final del documento.

const codigoTienda = z.string().regex(/^\d{4}$/, "Código de tienda de 4 dígitos");
const sku = z.string().regex(/^\d+$/, "SKU numérico como string");
const numeroNullable = z.number().finite().nullable();

export const ventaRowSchema = z.object({
  fecha: z.date(),
  codigoTienda,
  nombreTienda: z.string(),
  sku,
  idCompuesto: z.string(),
  descripcion: z.string(),
  marca: z.string(),
  division: z.string(),
  numProveedor: z.string(),
  proveedor: z.string(),
  unidades: z.number().finite(),
});

export const pronosticoRowSchema = ventaRowSchema
  .omit({ fecha: true, unidades: true })
  .extend({ semanaInicio: z.date(), valor: z.number().finite() });

export const forecastRowSchema = ventaRowSchema
  .omit({ unidades: true })
  .extend({ valor: z.number().finite() });

export const cedisRowSchema = z.object({
  sku,
  descripcion: z.string(),
  marca: z.string(),
  division: z.string(),
  numProveedor: z.string(),
  proveedor: z.string(),
  disponibilidadRealCD: numeroNullable,
  transitos: numeroNullable,
  sinCita: numeroNullable,
  citas: z.array(z.object({ fecha: z.date(), cantidad: z.number().finite() })),
  caracteristicaPlan: z.string(), // viene "21" y "ND" → string, no número
  minimo: numeroNullable,
  cobertura: numeroNullable,
  puntoPedido: numeroNullable,
  stockObjetivo: numeroNullable,
});

export const farmaciaRowSchema = z.object({
  idCompuesto: z.string(),
  codigoTienda,
  nombreTienda: z.string(),
  sku,
  descripcion: z.string(),
  marca: z.string(),
  division: z.string(),
  numProveedor: z.string(),
  nombreProveedor: z.string(),
  tipoArticulo: z.string(),
  abc: z.string(),
  sm: z.string(),
  cap: z.string(),
  stockSegMin: numeroNullable,
  cobertObjMin: numeroNullable,
  stockObjetivo: numeroNullable,
  puntoPedido: numeroNullable,
  stockDinamico: numeroNullable,
  stockMaximo: numeroNullable,
  libreUtilizacion: numeroNullable,
  transitoFarma: numeroNullable,
  sellingClass: numeroNullable,
  nivelInventario: numeroNullable,
});

export const lineaOcRowSchema = z.object({
  documentoCompras: z.string().min(1),
  posicion: numeroNullable,
  numProveedor: z.string(),
  nombreProveedor: z.string(),
  sku,
  descripcion: z.string(),
  marca: z.string(),
  division: z.string(),
  fechaPedido: z.date().nullable(),
  cantidadReparto: numeroNullable,
  unidadMedida: z.string(),
  cantidadEntregada: numeroNullable,
  fechaEntrega: z.date().nullable(),
  fillRate: numeroNullable, // fracción: 1 = 100%
  estatusOC: z.string(),
  negociador: z.string(),
  pedidoEnUMA: numeroNullable,
  ciDoctoCompras: z.string(),
  cpfr: z.string(),
});
