// Consultas de SOLO LECTURA sobre las colecciones de Retail, para exponerse
// como herramienta a KPS AI. Whitelist de colecciones y de campos POR
// colección; sin operadores crudos de Mongo ($where, $function…), límites
// acotados.
//
// Hay dos generaciones de datos y el modelo tiene que poder distinguirlas:
//
//   - VIGENTES: `salesReports` (el histórico que se carga desde
//     /retail/analisis, un documento por artículo × día por retailer),
//     `reportImports` (un documento por archivo cargado) y `sapSales` (las
//     líneas de factura de SAP copiadas a Mongo).
//   - RETIRADAS: las del flujo de ingesta por hojas fijas (ventas diarias,
//     pronósticos, inventarios, órdenes de compra, cargas). Sus modelos siguen
//     declarados, pero llevan tiempo sin recibir datos. Se dejan consultables
//     para no romper conversaciones antiguas, marcadas como no vigentes.
//
// El catálogo de abajo es también lo que el modelo SABE de Retail: de aquí
// sale el bloque CONTEXTO_RETAIL del prompt (lib/retail/contexto-ia.ts), así
// que un campo nuevo se añade una sola vez y llega a la tool y al prompt.
import type { Model } from "mongoose";
import { connectDB } from "@/lib/db";
import { DailyForecast } from "@/models/DailyForecast";
import { DailySale } from "@/models/DailySale";
import { DcStock } from "@/models/DcStock";
import { PharmacyStock } from "@/models/PharmacyStock";
import { PurchaseOrderLine } from "@/models/PurchaseOrderLine";
import { ReportImport } from "@/models/ReportImport";
import { SalesReport } from "@/models/SalesReport";
import { SapInvoiceBatch } from "@/models/SapInvoiceBatch";
import { SapInvoiceLine } from "@/models/SapInvoiceLine";
import { Upload } from "@/models/Upload";
import { WeeklyForecast } from "@/models/WeeklyForecast";
import { asegurarFacturasFrescas } from "@/lib/sap/sincronizar-facturas";

export type TipoCampo = "texto" | "numero" | "fecha";

export interface CampoRetail {
  campo: string;
  /** Cómo se llama el dato en el negocio; es lo que el modelo debe decir. */
  etiqueta: string;
  tipo: TipoCampo;
  /**
   * false para números que NO tiene sentido sumar (precios promedio, códigos,
   * folios): sumar avgPrice por mes y proyectarlo sería un disparate con
   * cara de cifra.
   */
  sumable?: boolean;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
interface DefinicionColeccion {
  modelo: Model<any>;
  descripcion: string;
  /** false = flujo retirado: existe, pero no recibe datos. */
  vigente: boolean;
  /** Campo de fecha de la colección: es por el que se agrupa con `mes`. */
  fecha: string | null;
  /**
   * Campos consultables con su etiqueta. Si se omite, se derivan del schema
   * de Mongoose (sin ids ni referencias) y la etiqueta es el propio nombre:
   * es lo que hacen las colecciones retiradas, que no merecen mantenimiento.
   */
  campos?: CampoRetail[];
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// Referencias internas que nunca tienen sentido para el modelo: ids de
// Mongo, quién escribió, ids técnicos de SAP y versiones.
const CAMPOS_INTERNOS = new Set([
  "_id",
  "__v",
  "uploadId",
  "importedBy",
  "reimportedBy",
  "loadId",
  "docEntry",
  "lineNum",
  "syncedAt",
]);

const CATALOGO = {
  salesReports: {
    modelo: SalesReport,
    vigente: true,
    fecha: "date",
    descripcion:
      "Histórico de ventas por retailer cargado desde los reportes de las cadenas. " +
      "Un documento por artículo × día. `account` es el retailer.",
    campos: [
      { campo: "account", etiqueta: "Retailer", tipo: "texto" },
      { campo: "date", etiqueta: "Fecha", tipo: "fecha" },
      { campo: "wmMonth", etiqueta: "Mes fiscal Walmart (AAAA/MM)", tipo: "texto" },
      { campo: "brand", etiqueta: "Marca", tipo: "texto" },
      { campo: "itemDesc", etiqueta: "Nombre del producto", tipo: "texto" },
      { campo: "itemNbr", etiqueta: "Código de artículo del retailer", tipo: "numero", sumable: false },
      { campo: "primeItemNbr", etiqueta: "Código del producto", tipo: "numero", sumable: false },
      { campo: "upc", etiqueta: "UPC", tipo: "texto" },
      { campo: "productCode", etiqueta: "Código de producto", tipo: "texto" },
      { campo: "posQty", etiqueta: "Unidades vendidas", tipo: "numero" },
      { campo: "posSales", etiqueta: "Ventas netas (importe)", tipo: "numero" },
      { campo: "avgPrice", etiqueta: "Precio promedio", tipo: "numero", sumable: false },
      { campo: "avgSalesPerStore", etiqueta: "Venta promedio por tienda", tipo: "numero", sumable: false },
      { campo: "itemQtySold", etiqueta: "Unidades (duplica posQty)", tipo: "numero" },
      { campo: "basketOccurrences", etiqueta: "Ocurrencias en canasta", tipo: "numero" },
      { campo: "sourceFiles", etiqueta: "Reportes (archivos) que contienen la fila", tipo: "texto" },
      { campo: "template", etiqueta: "Plantilla del reporte", tipo: "texto" },
      { campo: "importedAt", etiqueta: "Última escritura", tipo: "fecha" },
    ],
  },
  reportImports: {
    modelo: ReportImport,
    vigente: true,
    fecha: "importedAt",
    descripcion:
      "Un documento por archivo de reporte cargado a Retail: qué archivo, de qué retailer, " +
      "cuándo se subió por primera vez y cuándo se volvió a subir.",
    campos: [
      { campo: "account", etiqueta: "Retailer", tipo: "texto" },
      { campo: "sourceFile", etiqueta: "Archivo del reporte", tipo: "texto" },
      { campo: "template", etiqueta: "Plantilla del reporte", tipo: "texto" },
      { campo: "importedAt", etiqueta: "Primera carga", tipo: "fecha" },
      { campo: "reimportedAt", etiqueta: "Última re-subida", tipo: "fecha" },
      { campo: "lastWriteAt", etiqueta: "Última escritura", tipo: "fecha" },
    ],
  },
  sapSales: {
    modelo: SapInvoiceLine,
    vigente: true,
    fecha: "docDate",
    descripcion:
      "Todas las líneas de factura de venta de SAP Business One copiadas a Mongo " +
      "(histórico completo, se refresca solo). Sirve para ventas por artículo o por " +
      "cliente con filtros de fecha.",
    campos: [
      { campo: "docNum", etiqueta: "Folio de factura", tipo: "numero", sumable: false },
      { campo: "docDate", etiqueta: "Fecha de factura", tipo: "fecha" },
      { campo: "cardCode", etiqueta: "Código de cliente", tipo: "texto" },
      { campo: "cardName", etiqueta: "Cliente", tipo: "texto" },
      { campo: "itemCode", etiqueta: "Código de artículo", tipo: "texto" },
      { campo: "description", etiqueta: "Artículo", tipo: "texto" },
      { campo: "quantity", etiqueta: "Cantidad", tipo: "numero" },
      { campo: "price", etiqueta: "Precio unitario", tipo: "numero", sumable: false },
      { campo: "lineTotal", etiqueta: "Importe", tipo: "numero" },
      { campo: "currency", etiqueta: "Moneda", tipo: "texto" },
    ],
  },
  sapSalesLotes: {
    modelo: SapInvoiceBatch,
    vigente: true,
    fecha: "docDate",
    descripcion:
      "Lotes (batches) vendidos en cada línea de factura de SAP: una fila por factura × " +
      "línea × lote con las unidades que salieron de ese lote. Sirve para 'lotes más " +
      "vendidos', 'qué lotes se vendieron a X' o 'a quién se vendió el lote Y'. Si está " +
      "vacía, falta correr la sincronización completa de facturas.",
    campos: [
      { campo: "batch", etiqueta: "Lote", tipo: "texto" },
      { campo: "itemCode", etiqueta: "Código de artículo", tipo: "texto" },
      { campo: "description", etiqueta: "Artículo", tipo: "texto" },
      { campo: "quantity", etiqueta: "Unidades del lote", tipo: "numero" },
      { campo: "docNum", etiqueta: "Folio de factura", tipo: "numero", sumable: false },
      { campo: "docDate", etiqueta: "Fecha de factura", tipo: "fecha" },
      { campo: "cardCode", etiqueta: "Código de cliente", tipo: "texto" },
      { campo: "cardName", etiqueta: "Cliente", tipo: "texto" },
      { campo: "expiryDate", etiqueta: "Caducidad del lote", tipo: "fecha" },
    ],
  },
  // --- Flujo de ingesta retirado ------------------------------------------
  sales: {
    modelo: DailySale,
    vigente: false,
    fecha: "date",
    descripcion: "Ventas diarias por tienda y artículo del flujo de ingesta retirado (San Pablo).",
  },
  weeklyForecast: {
    modelo: WeeklyForecast,
    vigente: false,
    fecha: "weekStart",
    descripcion: "Pronóstico semanal por tienda y artículo del flujo retirado.",
  },
  dailyForecast: {
    modelo: DailyForecast,
    vigente: false,
    fecha: "date",
    descripcion: "Forecast diario por tienda y artículo del flujo retirado.",
  },
  dcStock: {
    modelo: DcStock,
    vigente: false,
    fecha: "cutoffDate",
    descripcion: "Inventario en CEDIS por artículo del flujo retirado.",
  },
  pharmacyStock: {
    modelo: PharmacyStock,
    vigente: false,
    fecha: "cutoffDate",
    descripcion: "Inventario en farmacias por tienda y artículo del flujo retirado.",
  },
  purchaseOrders: {
    modelo: PurchaseOrderLine,
    vigente: false,
    fecha: "cutoffDate",
    descripcion: "Líneas de órdenes de compra y fill rate del flujo retirado.",
  },
  uploads: {
    modelo: Upload,
    vigente: false,
    fecha: "cutoffDate",
    descripcion: "Archivos subidos por el flujo de ingesta retirado.",
  },
} satisfies Record<string, DefinicionColeccion>;

export type ColeccionRetail = keyof typeof CATALOGO;

// Las vigentes primero: es el orden en que las ve el modelo en el enum de la
// tool y en el prompt, y lo primero que se lee es lo que se usa.
export const COLECCIONES_RETAIL = Object.keys(CATALOGO) as [ColeccionRetail, ...ColeccionRetail[]];

/** Agrupación especial: por mes calendario (AAAA-MM) del campo de fecha. */
/** Cuántos valores distintos se ofrecen como pista cuando un filtro no encuentra nada. */
const VALORES_SUGERIDOS_MAX = 40;

export const AGRUPAR_POR_MES = "mes";
/**
 * Agrupación especial: por año (AAAA) del campo de fecha. Sin ella, "qué año
 * vendió más" obligaba al modelo a agrupar por mes y sumar 12 filas a mano:
 * comparaba el MES más alto de cada año en vez del total y respondía el año
 * equivocado (2025 en vez de 2026), distinto en cada intento.
 */
export const AGRUPAR_POR_ANIO = "año";

function tipoDeInstancia(instancia: string | undefined): TipoCampo | null {
  switch (instancia) {
    case "String":
      return "texto";
    case "Number":
    case "Decimal128":
      return "numero";
    case "Date":
      return "fecha";
    default:
      return null; // ObjectId, Mixed, Boolean, subdocumentos: no se exponen
  }
}

/** Campos consultables de una colección, con etiqueta y tipo. */
export function camposDe(coleccion: ColeccionRetail): CampoRetail[] {
  const def: DefinicionColeccion = CATALOGO[coleccion];
  if (def.campos) return def.campos;

  const campos: CampoRetail[] = [];
  def.modelo.schema.eachPath((ruta, tipoSchema) => {
    if (CAMPOS_INTERNOS.has(ruta) || ruta.includes(".")) return;
    // Un arreglo de escalares (p. ej. `sourceFiles`) se consulta por
    // contención con `igual`, así que se expone con el tipo de sus elementos.
    const instancia =
      tipoSchema.instance === "Array"
        ? (tipoSchema as { caster?: { instance?: string } }).caster?.instance
        : tipoSchema.instance;
    const tipo = tipoDeInstancia(instancia);
    if (tipo) campos.push({ campo: ruta, etiqueta: ruta, tipo });
  });
  return campos;
}

export interface EntradaCatalogo {
  coleccion: ColeccionRetail;
  descripcion: string;
  vigente: boolean;
  /** Campo de fecha por el que agrupa `mes`; null si no tiene. */
  fecha: string | null;
  campos: CampoRetail[];
}

/** El catálogo completo, en el orden en que lo ve el modelo. Sin tocar la base. */
export function catalogoRetail(): EntradaCatalogo[] {
  return COLECCIONES_RETAIL.map((coleccion) => {
    const def: DefinicionColeccion = CATALOGO[coleccion];
    return {
      coleccion,
      descripcion: def.descripcion,
      vigente: def.vigente,
      fecha: def.fecha,
      campos: camposDe(coleccion),
    };
  });
}

/** Modelo de Mongoose de la colección (para las tools que agregan a su manera). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function modeloDe(coleccion: ColeccionRetail): Model<any> {
  const def: DefinicionColeccion = CATALOGO[coleccion];
  return def.modelo;
}

/** Campo de fecha de la colección, o null si no tiene. */
export function fechaDe(coleccion: ColeccionRetail): string | null {
  const def: DefinicionColeccion = CATALOGO[coleccion];
  return def.fecha;
}

const PERMITIDOS = new Map<ColeccionRetail, Map<string, CampoRetail>>();

export function campoDe(coleccion: ColeccionRetail, campo: string): CampoRetail | null {
  let mapa = PERMITIDOS.get(coleccion);
  if (!mapa) {
    mapa = new Map(camposDe(coleccion).map((c) => [c.campo, c]));
    PERMITIDOS.set(coleccion, mapa);
  }
  return mapa.get(campo) ?? null;
}

/** Si `campo` se puede usar en filtros, orden o agrupación de `coleccion`. */
export function campoPermitido(coleccion: ColeccionRetail, campo: string): boolean {
  return campoDe(coleccion, campo) !== null;
}

/** Si `campo` es un número que tiene sentido sumar (unidades, importes). */
export function metricaSumable(coleccion: ColeccionRetail, campo: string): boolean {
  const c = campoDe(coleccion, campo);
  return c !== null && c.tipo === "numero" && c.sumable !== false;
}

const LIMITE_MAX = 50;

export interface ConsultaRetail {
  coleccion: ColeccionRetail;
  filtros?: Array<{
    field: string;
    operador: "igual" | "contiene" | "mayorQue" | "menorQue";
    value: string | number;
  }>;
  agruparPor?: string; // devuelve totales por ese campo, o por `mes`
  sumar?: string; // campo numérico a sumar en la agrupación
  ordenarPor?: string;
  dir?: "asc" | "desc";
  limite?: number;
}

export interface ResultadoRetail {
  total: number;
  devueltas: number;
  /**
   * En modo agregado, cada fila trae además `registros` y —si la colección
   * tiene campo de fecha— `desde`/`hasta` (AAAA-MM-DD): así "qué retailers
   * tienen datos y de qué periodo" es una sola llamada agrupando por account.
   */
  filas: Record<string, unknown>[];
  /** Filtros que se ignoraron por no ser campos de la colección. */
  camposIgnorados?: string[];
}

// Las fechas llegan como texto ISO y los campos de fecha son Date de BSON:
// sin convertir, Mongo compara tipos distintos y el filtro (igual O rango)
// devuelve silenciosamente cero filas.
function normalizarValor(value: string | number): string | number | Date {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? new Date(`${value}T00:00:00.000Z`)
    : value;
}

/**
 * Filtro de Mongo a partir de la consulta. Los campos que no existen en la
 * colección no se descartan en silencio: se devuelven aparte para que el
 * modelo sepa que su filtro no aplicó y no presente "0 resultados" como dato.
 *
 * Un rango es DOS filtros sobre el mismo campo (mayorQue + menorQue): se
 * acumulan en el mismo objeto de operadores. Antes el segundo pisaba al
 * primero y "marzo" se convertía en "todo hasta abril".
 */
export function construirFiltro(consulta: ConsultaRetail): {
  filtro: Record<string, unknown>;
  ignorados: string[];
} {
  const filtro: Record<string, unknown> = {};
  const rangos: Record<string, Record<string, unknown>> = {};
  const ignorados: string[] = [];
  for (const f of consulta.filtros ?? []) {
    if (!campoPermitido(consulta.coleccion, f.field)) {
      ignorados.push(f.field);
      continue;
    }
    if (f.operador === "contiene") {
      filtro[f.field] = {
        $regex: String(f.value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        $options: "i",
      };
    } else if (f.operador === "mayorQue") {
      (rangos[f.field] ??= {}).$gt = normalizarValor(f.value);
    } else if (f.operador === "menorQue") {
      (rangos[f.field] ??= {}).$lt = normalizarValor(f.value);
    } else {
      // `igual` sobre TEXTO ignora mayúsculas y acentos sobrantes. Las marcas
      // están guardadas en mayúsculas ("BLOOM"), así que un filtro brand="Bloom"
      // —como lo escribe cualquiera— devolvía CERO filas en silencio, y con cero
      // filas delante el modelo publicó un total de 33,627,515.90 inventado
      // (el real de BLOOM en Walmart es 32,618,924.77 en 3,556 registros).
      const def = campoDe(consulta.coleccion, f.field);
      if (def?.tipo === "texto" && typeof f.value === "string") {
        filtro[f.field] = {
          $regex: `^${f.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
          $options: "i",
        };
      } else {
        filtro[f.field] = normalizarValor(f.value);
      }
    }
  }
  // Un `igual` o `contiene` sobre el mismo campo manda sobre el rango.
  for (const [campo, ops] of Object.entries(rangos)) {
    if (!(campo in filtro)) filtro[campo] = ops;
  }
  return { filtro, ignorados };
}

function fechaISO(v: unknown): string | null {
  return v instanceof Date ? v.toISOString().slice(0, 10) : null;
}

/**
 * Deja un documento de `.lean()` apto para el contenido de un tool-result.
 * El AI SDK solo admite string/number/boolean/null/array/objeto plano: un
 * `Date` u `ObjectId` vivo lo rechaza ("expected string, received Date") y la
 * respuesta muere a mitad del streaming (AI_InvalidPromptError). Recorre
 * también subdocumentos y arrays (p. ej. `dcStock.appointments[].date`).
 */
function serializable(v: unknown): unknown {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  if (Array.isArray(v)) return v.map(serializable);
  if (v && typeof v === "object") {
    if (typeof (v as { toHexString?: unknown }).toHexString === "function") return String(v);
    if (typeof (v as { toJSON?: unknown }).toJSON === "function") return serializable((v as { toJSON: () => unknown }).toJSON());
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, serializable(x)]));
  }
  return v;
}

/** Expresión de `$group._id` para `agruparPor`, o null si no se puede agrupar por eso. */
function claveDeGrupo(coleccion: ColeccionRetail, agruparPor: string): unknown {
  if (agruparPor === AGRUPAR_POR_MES || agruparPor === AGRUPAR_POR_ANIO) {
    const def: DefinicionColeccion = CATALOGO[coleccion];
    const formato = agruparPor === AGRUPAR_POR_MES ? "%Y-%m" : "%Y";
    return def.fecha ? { $dateToString: { format: formato, date: `$${def.fecha}` } } : null;
  }
  return campoPermitido(coleccion, agruparPor) ? `$${agruparPor}` : null;
}

// La copia local de facturas puede no existir aún (falta `npm run sap:facturas`).
// Sin esta nota el modelo respondía "no puedo" en vez de ir a SAP en vivo.
const NOTA_COPIA_SAP_VACIA =
  "La copia local de facturas de SAP está vacía (falta la sincronización). NO concluyas que no hay ventas: " +
  "consulta SAP en vivo con agregar_sap sobre Invoices (filtro por DocDate; agruparPor [\"mes\"] o [\"CardName\"]) " +
  "o consultar_sap para el detalle.";

/**
 * Cuando una consulta no devuelve NADA y el filtro va sobre texto, lo más
 * probable es que el valor esté mal escrito, no que no haya ventas: "multilbue"
 * o "Bloom" daban cero filas y el modelo publicaba igualmente un total
 * inventado. Se le devuelven los valores que existen de verdad en ese campo
 * para que corrija o pregunte.
 */
async function pistaSinResultados(
  consulta: ConsultaRetail,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  model: Model<any>,
  total: number
): Promise<Record<string, unknown>> {
  if (total !== 0) return {};
  const sugerencias: Record<string, string[]> = {};
  for (const f of consulta.filtros ?? []) {
    if (f.operador !== "igual" || typeof f.value !== "string") continue;
    if (campoDe(consulta.coleccion, f.field)?.tipo !== "texto") continue;
    try {
      const valores = (await model.distinct(f.field, {})) as unknown[];
      const textos = valores.filter((v): v is string => typeof v === "string").sort();
      if (textos.length && textos.length <= VALORES_SUGERIDOS_MAX) sugerencias[f.field] = textos;
    } catch {
      // Si el distinct falla no se rompe la consulta: simplemente no hay pista.
    }
  }
  if (!Object.keys(sugerencias).length) return {};
  return {
    valoresDisponibles: sugerencias,
    notaSinResultados:
      "La consulta no devolvió NADA y filtra por texto: lo más probable es que el valor esté mal escrito, " +
      "no que no haya ventas. En `valoresDisponibles` están los que existen de verdad. Corrige y vuelve a " +
      "consultar, o pregunta cuál quería; NO respondas un total.",
  };
}

export async function consultarRetail(consulta: ConsultaRetail): Promise<ResultadoRetail> {
  // Un `sumar` que no se puede sumar no se ignora: devolver filas sin total
  // y sin aviso lleva al modelo a presentar el conteo como si fuera la cifra.
  if (consulta.sumar && !metricaSumable(consulta.coleccion, consulta.sumar)) {
    throw new Error(
      `"${consulta.sumar}" no es una métrica que se pueda sumar en ${consulta.coleccion}. Usa: ` +
        camposDe(consulta.coleccion)
          .filter((c) => metricaSumable(consulta.coleccion, c.campo))
          .map((c) => c.campo)
          .join(", ") +
        "."
    );
  }
  await connectDB();
  // sapSales es una copia de SAP: se refresca incremental (throttle de 5 min)
  // para que "toda la historia" incluya también las facturas de hoy.
  const esCopiaSap = consulta.coleccion === "sapSales" || consulta.coleccion === "sapSalesLotes";
  if (esCopiaSap) {
    await asegurarFacturasFrescas();
  }
  const def: DefinicionColeccion = CATALOGO[consulta.coleccion];
  if (!def) throw new Error(`Colección no permitida: ${consulta.coleccion}`);
  const model = def.modelo;
  const { filtro, ignorados } = construirFiltro(consulta);
  const limite = Math.min(Math.max(consulta.limite ?? 10, 1), LIMITE_MAX);
  const extra = ignorados.length ? { camposIgnorados: ignorados } : {};

  // Modo agregado: totales por campo (ej. unidades por marca), por mes, o el
  // TOTAL global del filtro cuando viene `sumar` sin `agruparPor`. Antes ese
  // caso caía en la rama de detalle (10 filas de muestra) y el modelo sumaba la
  // muestra y la presentaba como "importe total" ($88 K cuando eran $5.46 M).
  const clave = consulta.agruparPor ? claveDeGrupo(consulta.coleccion, consulta.agruparPor) : null;
  const totalGlobal = !consulta.agruparPor && !!consulta.sumar && campoPermitido(consulta.coleccion, consulta.sumar);
  if ((consulta.agruparPor && clave) || totalGlobal) {
    const campoSuma = consulta.sumar ?? null;
    let filas = await model.aggregate([
      { $match: filtro },
      {
        $group: {
          _id: clave,
          ...(campoSuma ? { total: { $sum: `$${campoSuma}` } } : {}),
          registros: { $sum: 1 },
          ...(def.fecha ? { desde: { $min: `$${def.fecha}` }, hasta: { $max: `$${def.fecha}` } } : {}),
        },
      },
      // Orden: si piden ordenar por la métrica sumada (o por registros) se
      // respeta con su dirección; si no, por mes es cronológico y el resto de
      // mayor a menor. Antes el orden pedido se ignoraba al agrupar por mes y
      // el $limit de 10 dejaba solo los primeros 10 meses: "el mes con más
      // ventas" salía febrero 2025 cuando era enero 2026.
      {
        $sort: ((): Record<string, 1 | -1> => {
          const dir: 1 | -1 = consulta.dir === "asc" ? 1 : -1;
          if (consulta.ordenarPor && campoSuma && consulta.ordenarPor === campoSuma) return { total: dir };
          if (consulta.ordenarPor === "registros") return { registros: dir };
          if (consulta.agruparPor === AGRUPAR_POR_MES || consulta.agruparPor === AGRUPAR_POR_ANIO)
            return { _id: 1 };
          return campoSuma ? { total: -1 } : { registros: -1 };
        })(),
      },
      // Agrupado no se recorta a 10 por defecto: 25 meses o 30 marcas caben
      // completos (tope LIMITE_MAX) y así no se decide un máximo sobre un trozo.
      {
        $facet: {
          filas: [{ $limit: consulta.limite ? limite : LIMITE_MAX }],
          conteo: [{ $count: "n" }],
          // Total sobre TODOS los grupos, no sólo los devueltos: sin esto el
          // modelo sumaba a mano la columna de su propia tabla ("123,989
          // piezas" cuando son 123,939) y calculaba porcentajes sobre un
          // denominador que no existe.
          general: [{ $group: { _id: null, total: { $sum: "$total" }, registros: { $sum: "$registros" } } }],
        },
      },
    ]);
    const gruposTotales: number = filas[0]?.conteo?.[0]?.n ?? 0;
    const general = filas[0]?.general?.[0];
    filas = filas[0]?.filas ?? [];
    return {
      total: gruposTotales,
      devueltas: filas.length,
      ...(esCopiaSap && gruposTotales === 0 ? { nota: NOTA_COPIA_SAP_VACIA } : {}),
      // `total` en el modo agregado son los GRUPOS, no las filas, y el nombre se
      // presta a confusión: preguntando "cuántos productos vende san pablo" el
      // modelo ni agrupaba —pedía la suma de unidades y contestaba 17,582
      // unidades en vez de 4 productos—. Con el conteo nombrado no hay duda.
      ...(consulta.agruparPor
        ? {
            valoresDistintos: gruposTotales,
            notaValoresDistintos:
              `Hay ${gruposTotales} valores distintos de "${consulta.agruparPor}" con este filtro. Ésa es ` +
              "la respuesta a \"cuántos productos / marcas / clientes distintos hay\": no cuentes las filas " +
              "devueltas, que son sólo las que caben.",
          }
        : {}),
      ...(await pistaSinResultados(consulta, model, gruposTotales)),
      ...(general && campoSuma
        ? {
            totalGeneral: {
              [campoSuma]: general.total,
              registros: general.registros,
              grupos: gruposTotales,
            },
            notaTotalGeneral:
              "`totalGeneral` suma TODOS los grupos, no sólo las filas devueltas: úsalo como total y como " +
              "denominador de porcentajes en vez de sumar la columna de la tabla.",
          }
        : {}),
      ...(gruposTotales > filas.length
        ? { nota: `Se muestran ${filas.length} de ${gruposTotales} grupos: pide más con limite o afina el orden.` }
        : {}),
      // La clave de grupo (`_id`) es un Date vivo cuando se agrupa por un
      // campo de fecha (p. ej. `agruparPor: "date"`); ver serializable().
      filas: filas.map(
        (f) =>
          serializable({
            ...(consulta.agruparPor ? { [consulta.agruparPor]: f._id } : {}),
            ...(campoSuma ? { [campoSuma]: f.total } : {}),
            registros: f.registros,
            ...(def.fecha ? { desde: fechaISO(f.desde), hasta: fechaISO(f.hasta) } : {}),
          }) as Record<string, unknown>
      ),
      ...extra,
    };
  }

  const total = await model.countDocuments(filtro);
  const orden =
    consulta.ordenarPor && campoPermitido(consulta.coleccion, consulta.ordenarPor)
      ? consulta.ordenarPor
      : "_id";
  const proyeccion = Object.fromEntries(
    [...CAMPOS_INTERNOS].filter((c) => c !== "_id").map((c) => [c, 0])
  );
  const filas = await model
    .find(filtro)
    .sort({ [orden]: consulta.dir === "asc" ? 1 : -1 })
    .limit(limite)
    .select(proyeccion)
    .lean();

  // Una consulta de DETALLE devuelve un TROZO de las filas, y contar o sumar
  // sobre ese trozo da una respuesta distinta según cuántas cayeron dentro.
  // Medido: "cuántos productos distintos de VITA VIBE" se contestó agrupando a
  // ojo 50 filas crudas (4 productos, cifras infladas) y, al repreguntar con el
  // límite por defecto de 10, sólo aparecieron 3 -> "son 3, LIMA no está en los
  // datos", descartando un producto real. Aquí se dice explícitamente.
  const esMuestra = total > filas.length;

  return {
    total,
    devueltas: filas.length,
    ...(esCopiaSap && total === 0 ? { nota: NOTA_COPIA_SAP_VACIA } : {}),
    ...(esMuestra
      ? {
          notaMuestra:
            `ATENCIÓN: son ${filas.length} filas de ${total}. Es una MUESTRA, no el conjunto. NO cuentes ` +
            "valores distintos ni sumes importes sobre ellas: lo que no cayó en la muestra parecería no " +
            "existir. Para contar productos, marcas o clientes distintos, o para cualquier total, repite " +
            "la consulta con `agruparPor` (el campo que quieres contar) y `sumar` (la métrica): eso lo " +
            "calcula el servidor sobre TODAS las filas y devuelve además el conteo real de grupos.",
        }
      : {}),
    ...(await pistaSinResultados(consulta, model, total)),
    // .lean() deja Date/ObjectId vivos (`date`, `cutoffDate`, anidados en
    // `appointments[]`...). Por eso fallaba solo en consultas de detalle con
    // fechas y no en las agregadas, que ya pasan por fechaISO(). Ver serializable().
    filas: filas.map((f) => serializable(f) as Record<string, unknown>),
    ...extra,
  };
}

/**
 * Qué retailers tienen datos AHORA MISMO, en una línea por retailer, para
 * inyectarlo en el prompt.
 *
 * El prompt enumeraba los cuatro identificadores del catálogo y el modelo los
 * recitaba como "los retailers cargados" aunque dos no tuvieran ni una fila:
 * ninguna regla ("no lo digas de memoria, consúltalo") lo evitó, porque tenía
 * la lista delante. La única forma de que no afirme algo falso es que lo que
 * tiene delante sea verdad.
 */
let coberturaCache: { texto: string; expira: number } | null = null;
const COBERTURA_TTL_MS = 5 * 60_000;

export async function coberturaRetailers(): Promise<string> {
  if (coberturaCache && coberturaCache.expira > Date.now()) return coberturaCache.texto;
  try {
    const { filas } = await consultarRetail({
      coleccion: "salesReports",
      agruparPor: "account",
      sumar: "posQty",
    });
    const texto = filas.length
      ? filas
          .map(
            (f) =>
              `- ${f.account}: ${Number(f.registros ?? 0).toLocaleString("es-MX")} registros, ` +
              `del ${f.desde} al ${f.hasta}`
          )
          .join("\n")
      : "- (ningún retailer tiene reportes cargados todavía)";
    coberturaCache = { texto, expira: Date.now() + COBERTURA_TTL_MS };
    return texto;
  } catch {
    // Si la consulta falla, mejor no decir nada que arriesgar una lista falsa.
    return "- (no se pudo consultar la cobertura: averíguala con consultar_retail antes de responder)";
  }
}
