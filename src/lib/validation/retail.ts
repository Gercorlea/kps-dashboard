import { z } from "zod";
import { RETAILER_IDS } from "@/lib/retail/retailers";

const fechaISO = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Formato de fecha: YYYY-MM-DD");

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
  // Identifica la CARGA, no el archivo: la misma subida troceada en lotes manda
  // el mismo valor en todos. Es lo que separa "este es el segundo lote" de "el
  // reporte se volvió a subir", que son la misma escritura vista desde el
  // servidor y fechan el reporte de forma distinta (ver models/ReportImport.ts).
  carga: z.string().min(1).max(64),
  filas: z.array(reporteVentaRowSchema).min(1).max(MAX_FILAS_LOTE),
});

export const historicoAnalisisQuerySchema = z.object({
  account: z.enum(RETAILER_IDS).optional(),
});

// Ficha de UN reporte guardado: lo que se abre al hacer clic en una fila de la
// lista de reportes del retailer. `sourceFile` es obligatorio —es la identidad
// del reporte— y `account` acota por si dos retailers guardaron un archivo con
// el mismo nombre.
export const reporteAnalisisQuerySchema = z.object({
  account: z.enum(RETAILER_IDS).optional(),
  sourceFile: z.string().min(1).max(300),
});

// Borrar un reporte del histórico. Aquí el retailer es OBLIGATORIO, al revés
// que al leerlo: dos retailers pueden haber guardado un archivo con el mismo
// nombre, y un borrado sin acotar se llevaría por delante el del otro.
export const borrarReporteSchema = z.object({
  account: z.enum(RETAILER_IDS),
  sourceFile: z.string().min(1).max(300),
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

export const resumenAnalisisQuerySchema = z
  .object({
    account: z.enum(RETAILER_IDS).optional(),
    sourceFile: z.string().min(1).max(300).optional(),
    parte: z.enum(["bundle", "serie"]).default("bundle"),
    granularidad: z.enum(["dia", "mes", "anio"]).optional(),
    // "archivo" agrega un solo reporte —lo que mira /retail/analisis— y "cuenta"
    // agrega todos los del retailer, que es lo que necesita su ficha.
    alcance: z.enum(["archivo", "cuenta"]).default("archivo"),
    // Periodo que mira la pestaña de Ventas de la ficha del retailer. Ausentes
    // significa TODO el histórico, que es lo que pide la carga inicial: así el
    // primer viaje sigue compartiendo entrada de caché con la de antes.
    desde: fechaISO.optional(),
    hasta: fechaISO.optional(),
  })
  // Se comparan como TEXTO y no como Date: la clave ISO con ceros a la
  // izquierda ordena alfabéticamente igual que cronológicamente, y así no entra
  // una zona horaria a decidir si el rango es válido.
  .refine((q) => !q.desde || !q.hasta || q.desde <= q.hasta, {
    message: "El inicio del periodo no puede ser posterior al fin",
    path: ["desde"],
  });

export const filasAnalisisQuerySchema = z.object({
  account: z.enum(RETAILER_IDS).optional(),
  sourceFile: z.string().min(1).max(300).optional(),
  buscar: z.string().max(120).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(FILAS_POR_PAGINA).default(FILAS_POR_PAGINA),
});
