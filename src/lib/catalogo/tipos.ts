// Tipos que comparten las rutas y los componentes del módulo.
//
// Los tipos de ENTRADA (lo que el cliente manda al guardar) no están aquí: se
// derivan con z.infer de lib/validation/catalogo.ts, para que el esquema que
// valida y el tipo que compila no puedan discrepar.

import type { UsuarioResumen } from "@/lib/usuarios";
import type { ICatalogIssue } from "@/models/CatalogLoad";

export type Incidencia = ICatalogIssue;

/** Fila de la tabla principal: sólo las 7 columnas que se muestran. */
export interface FilaCatalogo {
  item: string;
  description: string;
  salesUnit: string;
  status: string;
  line: string;
  upc: string;
  /** "YYYY-MM-DD" o null. */
  launchDate: string | null;
  /** Lo que traía el archivo si la fecha no se pudo interpretar. */
  launchDateText: string;
}

/**
 * Orden en que viajan las celdas de FilaCatalogo cuando la respuesta manda
 * arreglos en vez de objetos.
 *
 * Las filas viajan como arreglos para no repetir el nombre de cada campo en
 * cada fila —el mismo recurso, y por el mismo motivo, que
 * /api/retail/analisis/filas—. Esta constante es el contrato: el servidor
 * proyecta en este orden y el cliente reconstruye con él, así que cualquier
 * cambio se hace aquí y en un solo sitio.
 */
export const CAMPOS_CATALOGO = [
  "item",
  "description",
  "salesUnit",
  "status",
  "line",
  "upc",
  "launchDate",
  "launchDateText",
] as const satisfies readonly (keyof FilaCatalogo)[];

/** Fila de la tabla de mapeo. */
export interface FilaMapeo {
  sku: string;
  channel: string;
  channelName: string;
  knownRetailer: boolean;
  customerCode: string;
  /** Si el sku existe en el catálogo de la misma carga. */
  enCatalogo: boolean;
  description: string;
}

export const CAMPOS_MAPEO = [
  "sku",
  "channel",
  "channelName",
  "knownRetailer",
  "customerCode",
  "enCatalogo",
  "description",
] as const satisfies readonly (keyof FilaMapeo)[];

/** Ventas agregadas de un producto en un canal. */
export interface VentaCanal {
  unidades: number;
  importe: number;
  filas: number;
  /** "YYYY-MM-DD". */
  desde: string | null;
  hasta: string | null;
}

/** Un canal en la ficha del producto, con sus ventas si las hay. */
export interface MapeoConVentas {
  channel: string;
  channelName: string;
  knownRetailer: boolean;
  customerCode: string;
  customerCodeNum: number | null;
  description: string;
  /**
   * null cuando el canal no cruza (desconocido o código no numérico) o cuando
   * cruza pero no hay ventas suyas en la base. La UI distingue los dos casos
   * con `knownRetailer` y `customerCodeNum`: "no se puede cruzar" y "no hay
   * ventas" son cosas distintas y sólo la primera es un aviso.
   */
  ventas: VentaCanal | null;
}

/** Todos los campos del producto, para la ficha. */
export interface DetalleProducto {
  item: string;
  description: string;
  ecom: string;
  trello: string;
  salesUnit: string;
  status: string;
  line: string;
  upc: string;
  satCode: string;
  tariffCode: string;
  suv: string;
  grammage: number | null;
  shelfLifeMonths: number | null;
  launchDate: string | null;
  launchDateText: string;
  suppliers: string[];
  rowNumber: number;
}

export interface FichaProducto {
  producto: DetalleProducto;
  mapeos: MapeoConVentas[];
  totales: { unidades: number; importe: number; canalesConVenta: number };
}

/** Quién subió la carga activa. Se reutiliza el tipo de lib/usuarios para que
 *  la cabecera pueda pintarlo con AutorReporte, igual que en retail. */
export type AutorCarga = UsuarioResumen;

/** La carga activa, tal como la muestra la cabecera del módulo. */
export interface CargaActiva {
  loadId: string;
  filename: string;
  productos: number;
  mapeos: number;
  descartados: { productos: number; mapeos: number };
  huerfanos: number;
  /** ISO. */
  finalizadaEl: string | null;
  subidaPor: AutorCarga | null;
  incidencias: Incidencia[];
}

/** Opción de un `select` de filtro, con cuántas filas tiene. */
export interface Faceta {
  id: string;
  etiqueta: string;
  filas: number;
}

/**
 * Lo que devuelve /api/catalogo/resumen.
 *
 * No trae las opciones de los filtros: su conteo depende de qué otros filtros
 * estén puestos, así que se calculan en el navegador con `facetasCon`.
 */
export interface ResumenCatalogo {
  /** null = nunca se ha cargado un catálogo. */
  carga: CargaActiva | null;
  /** Productos de la carga sin ninguna fila de mapeo: el dato accionable. */
  productosSinMapeo: number;
}
