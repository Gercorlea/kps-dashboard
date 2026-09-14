import { z } from "zod";

// Contratos del módulo de catálogo.
//
// El cliente ya leyó el Excel y mapeó los encabezados a campos, así que aquí se
// valida la FORMA FINAL de las filas, no el archivo.
//
// Qué es obligatorio se decide una sola vez, en lib/catalogo/columnas.ts, y este
// esquema dice lo mismo: item/description/status/line en el catálogo y
// sku/channel en el mapeo son `.min(1)`; todo lo demás admite vacío. Si las dos
// listas se separaran, el lector descartaría filas que el servidor acepta —o al
// revés— y el módulo perdería datos sin decir nada.

/** Se envía por lotes: el mismo tamaño que usa el analizador de retail. */
export const MAX_FILAS_LOTE_CATALOGO = 2000;

/**
 * Tope de filas de una carga.
 *
 * No es un límite operativo —el catálogo son ~140 productos— sino una red de
 * seguridad: un archivo con decenas de miles de filas no es el catálogo, es otro
 * archivo. Es además el punto donde la tabla, que se trae completa al navegador,
 * dejaría de ser razonable.
 *
 * Vive aquí y no en el lector para que las rutas de servidor no tengan que
 * importar el lector —que es código de navegador— sólo por una constante. Es la
 * misma dirección de dependencia que MAX_FILAS_LOTE en validation/retail.ts.
 */
export const MAX_FILAS_CATALOGO = 20_000;

/**
 * Filas por página de las dos tablas.
 *
 * La paginación es del NAVEGADOR, no del servidor: el buscador tiene que
 * responder en cada tecla como el de la pestaña Productos de la ficha del
 * retailer, y eso pide tener las filas ya en memoria. Ver la nota en
 * app/api/catalogo/productos/route.ts.
 */
export const PRODUCTOS_POR_PAGINA_CATALOGO = 40;

const fechaISO = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Formato de fecha: YYYY-MM-DD");

/** Código de barras, clave SAT, código de cliente: texto, nunca número. */
const codigo = z.string().max(60);

/**
 * Slug del canal. Lo calcula el cliente (lib/catalogo/canales.ts) y se valida
 * aquí: sin esto un canal con espacios o mayúsculas llegaría como dos canales
 * distintos y la tabla mostraría "Walmart" y "walmart" por separado.
 */
const slugCanal = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,59}$/, "El canal debe venir como slug: walmart, san-pablo…");

export const productoCatalogoRowSchema = z.object({
  // Los cuatro que no pueden ir vacíos.
  item: z.string().min(1).max(60),
  description: z.string().min(1).max(400),
  status: z.string().min(1).max(60),
  line: z.string().min(1).max(80),

  // ECOM y Trello son texto libre: el vocabulario lo pone quien mantiene el
  // Excel y un enum obligaría a vaciar un valor escrito a propósito.
  ecom: z.string().max(40).default(""),
  trello: z.string().max(40).default(""),

  salesUnit: z.string().max(40).default(""),
  upc: codigo.default(""),
  satCode: codigo.default(""),
  tariffCode: codigo.default(""),
  suv: z.string().max(40).default(""),

  // Ausente ≠ 0: una celda vacía llega como null y se guarda como null.
  grammage: z.number().finite().nullable().default(null),
  shelfLifeMonths: z.number().finite().nullable().default(null),

  launchDate: fechaISO.nullable().default(null),
  launchDateText: z.string().max(60).default(""),
  suppliers: z.array(z.string().max(200)).max(3).default([]),
  rowNumber: z.number().int().nonnegative().default(0),
});

export type ProductoCatalogoRow = z.infer<typeof productoCatalogoRowSchema>;

export const mapeoCatalogoRowSchema = z.object({
  sku: z.string().min(1).max(60),
  channel: slugCanal,
  channelName: z.string().max(120).default(""),
  knownRetailer: z.boolean().default(false),
  // Puede ir vacío: la cadena todavía no dio de alta el producto.
  customerCode: codigo.default(""),
  customerCodeNum: z.number().int().finite().nullable().default(null),
  description: z.string().max(400).default(""),
  rowNumber: z.number().int().nonnegative().default(0),
});

export type MapeoCatalogoRow = z.infer<typeof mapeoCatalogoRowSchema>;

export const incidenciaSchema = z.object({
  sheet: z.string().max(120).default(""),
  row: z.number().int().nonnegative().optional(),
  field: z.string().max(60).optional(),
  message: z.string().max(400),
  severity: z.enum(["error", "aviso", "info"]),
});

/** Cuántas incidencias se guardan. Más allá, la lista deja de ser accionable. */
export const MAX_INCIDENCIAS = 200;

export const crearCargaSchema = z.object({
  filename: z.string().min(1).max(300),
  sizeBytes: z.number().int().nonnegative(),
  productSheet: z.string().max(120).default(""),
  mappingSheet: z.string().max(120).nullable().default(null),
  // Al menos un producto: una carga vacía no puede activarse porque dejaría el
  // módulo en blanco, y es mejor decirlo antes de escribir nada.
  declaredProducts: z.number().int().min(1).max(MAX_FILAS_CATALOGO),
  declaredMappings: z.number().int().min(0).max(MAX_FILAS_CATALOGO),
  discardedProducts: z.number().int().min(0).default(0),
  discardedMappings: z.number().int().min(0).default(0),
});

/**
 * Un lote de filas. Discriminado por `tipo` para que las dos hojas compartan
 * endpoint sin que una fila de mapeo pueda colarse como producto.
 */
export const lotesCargaSchema = z.discriminatedUnion("tipo", [
  z.object({
    tipo: z.literal("productos"),
    filas: z.array(productoCatalogoRowSchema).min(1).max(MAX_FILAS_LOTE_CATALOGO),
  }),
  z.object({
    tipo: z.literal("mapeo"),
    filas: z.array(mapeoCatalogoRowSchema).min(1).max(MAX_FILAS_LOTE_CATALOGO),
  }),
]);

export const finalizarCargaSchema = z.object({
  incidencias: z.array(incidenciaSchema).max(MAX_INCIDENCIAS).default([]),
  /**
   * Qué carga veía activa el cliente al empezar. Sólo sirve para avisar: si al
   * finalizar resulta que se reemplazó otra, alguien subió un catálogo mientras
   * este archivo se estaba leyendo y quien sube tiene que saberlo.
   */
  loadIdPrevio: z.string().uuid().nullable().default(null),
});

/** La ficha se pide por Item; el resto de la tabla ya está en el navegador. */
export const productoQuerySchema = z.object({
  item: z.string().min(1).max(60),
});
