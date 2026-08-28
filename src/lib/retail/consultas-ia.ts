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
export const AGRUPAR_POR_MES = "mes";

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
      filtro[f.field] = normalizarValor(f.value);
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

/** Expresión de `$group._id` para `agruparPor`, o null si no se puede agrupar por eso. */
function claveDeGrupo(coleccion: ColeccionRetail, agruparPor: string): unknown {
  if (agruparPor === AGRUPAR_POR_MES) {
    const def: DefinicionColeccion = CATALOGO[coleccion];
    return def.fecha ? { $dateToString: { format: "%Y-%m", date: `$${def.fecha}` } } : null;
  }
  return campoPermitido(coleccion, agruparPor) ? `$${agruparPor}` : null;
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
  if (consulta.coleccion === "sapSales" || consulta.coleccion === "sapSalesLotes") {
    await asegurarFacturasFrescas();
  }
  const def: DefinicionColeccion = CATALOGO[consulta.coleccion];
  if (!def) throw new Error(`Colección no permitida: ${consulta.coleccion}`);
  const model = def.modelo;
  const { filtro, ignorados } = construirFiltro(consulta);
  const limite = Math.min(Math.max(consulta.limite ?? 10, 1), LIMITE_MAX);
  const extra = ignorados.length ? { camposIgnorados: ignorados } : {};

  // Modo agregado: totales por campo (ej. unidades por marca) o por mes.
  const clave = consulta.agruparPor ? claveDeGrupo(consulta.coleccion, consulta.agruparPor) : null;
  if (consulta.agruparPor && clave) {
    const campoSuma = consulta.sumar ?? null;
    const filas = await model.aggregate([
      { $match: filtro },
      {
        $group: {
          _id: clave,
          ...(campoSuma ? { total: { $sum: `$${campoSuma}` } } : {}),
          registros: { $sum: 1 },
          ...(def.fecha ? { desde: { $min: `$${def.fecha}` }, hasta: { $max: `$${def.fecha}` } } : {}),
        },
      },
      // Por mes se lee en orden cronológico; el resto, de mayor a menor.
      {
        $sort:
          consulta.agruparPor === AGRUPAR_POR_MES
            ? { _id: 1 }
            : campoSuma
              ? { total: -1 }
              : { registros: -1 },
      },
      { $limit: limite },
    ]);
    return {
      total: filas.length,
      devueltas: filas.length,
      filas: filas.map((f) => ({
        [consulta.agruparPor!]: f._id,
        ...(campoSuma ? { [campoSuma]: f.total } : {}),
        registros: f.registros,
        ...(def.fecha ? { desde: fechaISO(f.desde), hasta: fechaISO(f.hasta) } : {}),
      })),
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

  return {
    total,
    devueltas: filas.length,
    // .lean() deja objetos Date vivos (p. ej. `date`, `cutoffDate`). El AI SDK
    // valida el contenido del tool-result y solo admite string/number/null:
    // un Date lo rechaza con "expected string, received Date" y la respuesta
    // muere a mitad del streaming (AI_InvalidPromptError). Por eso fallaba solo
    // en consultas de detalle con fechas y no en las agregadas. Se serializan a
    // ISO (YYYY-MM-DD), como el modelo ya ve las fechas en el resto.
    filas: filas.map((f) =>
      Object.fromEntries(
        Object.entries({ ...f, _id: String((f as { _id: unknown })._id) }).map(([k, v]) => [
          k,
          v instanceof Date ? v.toISOString().slice(0, 10) : v,
        ])
      )
    ),
    ...extra,
  };
}
