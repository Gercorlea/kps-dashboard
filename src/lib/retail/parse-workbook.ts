import * as XLSX from "xlsx";
import type { ZodError } from "zod";
import {
  cedisRowSchema,
  farmaciaRowSchema,
  lineaOcRowSchema,
  ventaRowSchema,
} from "@/lib/validation/retail";
import { derivarMarca } from "./brands";
import {
  normHeader,
  parseCellDate,
  parseHeaderDate,
  toCode,
  toCodigoTienda,
  toNumber,
  toText,
} from "./normalize";

// Parser del Excel semanal (§7). Corre SIEMPRE en el servidor. Cada una de
// las seis trampas del §7.1 está blindada y cubierta por tests.

export interface IncidenciaParseo {
  sheet: string;
  row?: number;
  field?: string;
  message: string;
}

export type TipoHoja =
  | "cedis"
  | "sales"
  | "weeklyForecast"
  | "fcMean"
  | "fillRate"
  | "invFarma";

export interface HojaParseada {
  name: string;
  tipo: TipoHoja | null;
  read: number;
  rejected: number;
  issues: IncidenciaParseo[];
  docs: Record<string, unknown>[];
}

export interface ResultadoParseo {
  hojas: HojaParseada[];
}

// Más allá de 100 incidencias por hoja solo se conserva el conteo (§7.5).
const MAX_INCIDENCIAS_POR_HOJA = 100;

const TIPO_POR_NOMBRE: Record<string, TipoHoja> = {
  CEDIS: "cedis",
  VENTAS: "sales",
  PRONOSTICOS: "weeklyForecast",
  FC_MEAN: "fcMean",
  "FC MEAN": "fcMean",
  "FILL RATE": "fillRate",
  "INV FARMA": "invFarma",
};

// Reconocimiento por nombre normalizado, tolerando mayúsculas, espacios
// y acentos ("PRONÓSTICOS" → PRONOSTICOS) (§7.2).
export function tipoDeHoja(name: string): TipoHoja | null {
  const clave = normHeader(name)
    .toUpperCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
  return TIPO_POR_NOMBRE[clave] ?? null;
}

class Registrador {
  issues: IncidenciaParseo[] = [];
  private omitidas = 0;

  constructor(private sheet: string) {}

  agregar(message: string, row?: number, field?: string) {
    if (this.issues.length >= MAX_INCIDENCIAS_POR_HOJA) {
      this.omitidas++;
      return;
    }
    this.issues.push({
      sheet: this.sheet,
      ...(row !== undefined ? { row } : {}),
      ...(field ? { field } : {}),
      message,
    });
  }

  cerrar() {
    if (this.omitidas > 0) {
      this.issues.push({
        sheet: this.sheet,
        message: `…y ${this.omitidas} incidencias más (solo se registran las primeras ${MAX_INCIDENCIAS_POR_HOJA}).`,
      });
    }
  }
}

type Celda = unknown;

function leerMatriz(ws: XLSX.WorkSheet): Celda[][] {
  return XLSX.utils.sheet_to_json<Celda[]>(ws, {
    header: 1,
    raw: true,
    blankrows: false,
    defval: null,
  });
}

// Trampa 1: el ancho real de la tabla es la fila 1 caminada desde la
// columna A hasta la primera celda vacía. Todo lo que está a la derecha
// (tablas dinámicas del analista) se ignora por completo.
function anchoTabla(encabezados: Celda[]): number {
  let ancho = 0;
  while (ancho < encabezados.length) {
    const h = encabezados[ancho];
    if (h === null || h === undefined || String(h).trim() === "") break;
    ancho++;
  }
  return ancho;
}

// Trampa 6: corta en la primera fila completamente vacía DENTRO del ancho
// de la tabla; no confiar en hoja['!ref'].
function filaVacia(row: Celda[], ancho: number): boolean {
  for (let c = 0; c < ancho; c++) {
    const v = row[c];
    if (v !== null && v !== undefined && String(v).trim() !== "") return false;
  }
  return true;
}

function primerError(error: ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "validación fallida";
  const ruta = issue.path.join(".");
  return ruta ? `${ruta}: ${issue.message}` : issue.message;
}

interface ColumnaFecha {
  col: number;
  date: Date;
}

interface Clasificacion {
  dims: Record<string, number>;
  fechas: ColumnaFecha[];
}

// Evalúa columna por columna: una columna es de fecha si su encabezado es
// Date real o hace match con dd.mm.yyyy / yyyy-mm-dd (Trampa 2). En CEDIS
// las fechas están EN MEDIO de la tabla, así que después del bloque de
// fechas pueden volver columnas de dimensión (§7.2).
function clasificarColumnas(
  encabezados: Celda[],
  ancho: number,
  mapa: Record<string, string>,
  reg: Registrador,
  opciones?: {
    excluir?: (h: string) => boolean;
    prefijos?: Array<{ prefijo: string; field: string }>;
  }
): Clasificacion {
  const dims: Record<string, number> = {};
  const fechas: ColumnaFecha[] = [];

  for (let c = 0; c < ancho; c++) {
    const bruto = encabezados[c];
    const date = parseHeaderDate(bruto);
    if (date) {
      fechas.push({ col: c, date });
      continue;
    }
    const h = normHeader(bruto);
    if (opciones?.excluir?.(h)) continue;
    // Trampa 4: columnas con el mes hardcodeado se mapean por prefijo.
    const porPrefijo = opciones?.prefijos?.find((p) => h.startsWith(p.prefijo));
    if (porPrefijo) {
      dims[porPrefijo.field] = c;
      continue;
    }
    const field = mapa[h];
    if (field !== undefined) {
      dims[field] = c;
      continue;
    }
    reg.agregar(`Columna no reconocida, ignorada: "${h}"`, 1);
  }

  // Si un encabezado esperado no aparece, no truena la carga: incidencia,
  // campo en null y seguimos (Trampa 4).
  const esperados = new Map<string, string>();
  for (const [name, field] of Object.entries(mapa)) {
    if (!esperados.has(field)) esperados.set(field, name);
  }
  for (const p of opciones?.prefijos ?? []) {
    if (!esperados.has(p.field)) esperados.set(p.field, `${p.prefijo}…`);
  }
  for (const [field, name] of esperados) {
    if (!(field in dims)) {
      reg.agregar(
        `Columna esperada no encontrada: "${name}" — el campo ${field} quedará vacío`,
        1,
        field
      );
    }
  }

  return { dims, fechas };
}

type Lector = (field: string) => Celda;

function lectorDeFila(row: Celda[], dims: Record<string, number>): Lector {
  return (field: string) => {
    const c = dims[field];
    return c === undefined ? null : row[c];
  };
}

// Las marcas sin clasificar se agrupan por descripción única para que la
// UI muestre conteo y lista, sin registrar miles de incidencias (§7.3).
class MarcasSinClasificar {
  private mapa = new Map<string, number>();

  registrar(description: string) {
    if (!description) return;
    this.mapa.set(description, (this.mapa.get(description) ?? 0) + 1);
  }

  volcar(reg: Registrador) {
    for (const [description, filas] of this.mapa) {
      reg.agregar(`Marca sin clasificar (${filas} filas): "${description}"`, undefined, "brand");
    }
  }
}

function validarIdCompuesto(
  doc: { compositeId: string; storeCode: string; sku: string },
  row: number,
  reg: Registrador
) {
  if (!doc.compositeId || !doc.storeCode || !doc.sku) return;
  const esperado = `${doc.storeCode}${doc.sku}`;
  // Excel guarda el ID como número y pierde el cero inicial de la tienda
  // ("0141" + "70890001" → 14170890001): comparar con ceros normalizados.
  if (doc.compositeId.padStart(esperado.length, "0") !== esperado) {
    reg.agregar(
      `ID compuesto inconsistente: "${doc.compositeId}" ≠ tienda "${doc.storeCode}" + SKU "${doc.sku}"`,
      row,
      "compositeId"
    );
  }
}

interface CuerpoHoja {
  read: number;
  rejected: number;
  docs: Record<string, unknown>[];
}

// ---------------------------------------------------------------------
// VENTAS / PRONOSTICOS / FC_Mean: mismas dimensiones + columnas de fecha
// dinámicas al final. Se desnormalizan (unpivot) a documentos individuales
// { …dimensiones, date, value } (§6.1).
// ---------------------------------------------------------------------

const MAPA_LARGO: Record<string, string> = {
  "Ubic.": "storeCode",
  "Nombre de Farmacias": "storeName",
  "Prod.": "sku",
  ID: "compositeId",
  Descripción: "description",
  División: "division",
  "Num Proveedor": "vendorCode",
  Proveedor: "vendorName",
};

const baseLargaSchema = ventaRowSchema.omit({ date: true, units: true });

function parseHojaLarga(
  matriz: Celda[][],
  tipo: "sales" | "weeklyForecast" | "fcMean",
  reg: Registrador
): CuerpoHoja {
  const encabezados = matriz[0] ?? [];
  const ancho = anchoTabla(encabezados);
  if (ancho === 0) {
    reg.agregar("La hoja no tiene encabezados en la fila 1");
    return { read: 0, rejected: 0, docs: [] };
  }

  // En FC_Mean, "Total" y "Total red" NO son fechas ni datos: los totales
  // cacheados de un Excel manual son lo primero que queda desactualizado.
  const excluir =
    tipo === "fcMean"
      ? (h: string) => {
          const k = h.toUpperCase();
          return k === "TOTAL" || k === "TOTAL RED";
        }
      : undefined;

  const { dims, fechas } = clasificarColumnas(encabezados, ancho, MAPA_LARGO, reg, { excluir });
  if (fechas.length === 0) {
    reg.agregar("No se detectaron columnas de fecha en la hoja");
  }

  const campoFecha = tipo === "weeklyForecast" ? "weekStart" : "date";
  const campoValor = tipo === "sales" ? "units" : "value";
  const sinMarca = new MarcasSinClasificar();
  const docs: Record<string, unknown>[] = [];
  let read = 0;
  let rejected = 0;

  for (let r = 1; r < matriz.length; r++) {
    const row = matriz[r] ?? [];
    if (filaVacia(row, ancho)) break;
    read++;
    const get = lectorDeFila(row, dims);

    const description = toText(get("description"));
    const { brand, clasificada } = derivarMarca(description);
    if (!clasificada) sinMarca.registrar(description);

    const base = {
      storeCode: toCodigoTienda(get("storeCode")),
      storeName: toText(get("storeName")),
      sku: toCode(get("sku")),
      compositeId: toCode(get("compositeId")),
      description,
      brand,
      division: toText(get("division")),
      vendorCode: toCode(get("vendorCode")),
      vendorName: toText(get("vendorName")),
    };

    const check = baseLargaSchema.safeParse(base);
    if (!check.success) {
      rejected++;
      reg.agregar(`Fila rechazada: ${primerError(check.error)}`, r + 1);
      continue;
    }
    validarIdCompuesto(base, r + 1, reg);

    for (const { col, date } of fechas) {
      const value = toNumber(row[col]);
      if (value === null) continue; // ausente ≠ 0 (§7.5)
      docs.push({ ...base, [campoFecha]: date, [campoValor]: value });
    }
  }

  sinMarca.volcar(reg);
  return { read, rejected, docs };
}

// ---------------------------------------------------------------------
// CEDIS: fechas de citas EN MEDIO de la tabla, unpivot embebido en `citas`.
// ---------------------------------------------------------------------

const MAPA_CEDIS: Record<string, string> = {
  Artículo: "sku",
  "Texto breve de artículo": "description",
  División: "division",
  "Num Proveedor": "vendorCode",
  Proveedor: "vendorName",
  "Disponibilidad Real CD": "realAvailabilityDC",
  Tránsitos: "inTransit",
  Transitos: "inTransit",
  "SIN CITA": "withoutAppointment",
  "Caracteristica de plan": "planCharacteristic",
  "Característica de plan": "planCharacteristic",
  Mínimo: "minimum",
  Minimo: "minimum",
  Cobertura: "coverage",
  "Punto de Pedido": "reorderPoint",
  "Stock Objetivo": "targetStock",
};

function parseCedis(matriz: Celda[][], reg: Registrador): CuerpoHoja {
  const encabezados = matriz[0] ?? [];
  const ancho = anchoTabla(encabezados);
  if (ancho === 0) {
    reg.agregar("La hoja no tiene encabezados en la fila 1");
    return { read: 0, rejected: 0, docs: [] };
  }

  const { dims, fechas } = clasificarColumnas(encabezados, ancho, MAPA_CEDIS, reg);
  const sinMarca = new MarcasSinClasificar();
  const docs: Record<string, unknown>[] = [];
  let read = 0;
  let rejected = 0;

  for (let r = 1; r < matriz.length; r++) {
    const row = matriz[r] ?? [];
    if (filaVacia(row, ancho)) break;
    read++;
    const get = lectorDeFila(row, dims);

    const description = toText(get("description"));
    const { brand, clasificada } = derivarMarca(description);
    if (!clasificada) sinMarca.registrar(description);

    const appointments: Array<{ date: Date; quantity: number }> = [];
    for (const { col, date } of fechas) {
      const quantity = toNumber(row[col]);
      if (quantity === null) continue;
      appointments.push({ date, quantity });
    }

    const doc = {
      sku: toCode(get("sku")),
      description,
      brand,
      division: toText(get("division")),
      vendorCode: toCode(get("vendorCode")),
      vendorName: toText(get("vendorName")),
      realAvailabilityDC: toNumber(get("realAvailabilityDC")),
      inTransit: toNumber(get("inTransit")),
      withoutAppointment: toNumber(get("withoutAppointment")),
      appointments,
      planCharacteristic: toText(get("planCharacteristic")), // "21" y "ND" → string
      minimum: toNumber(get("minimum")),
      coverage: toNumber(get("coverage")),
      reorderPoint: toNumber(get("reorderPoint")),
      targetStock: toNumber(get("targetStock")),
    };

    const check = cedisRowSchema.safeParse(doc);
    if (!check.success) {
      rejected++;
      reg.agregar(`Fila rechazada: ${primerError(check.error)}`, r + 1);
      continue;
    }
    docs.push(doc);
  }

  sinMarca.volcar(reg);
  return { read, rejected, docs };
}

// ---------------------------------------------------------------------
// Fill Rate: 18 columnas fijas, sin fechas dinámicas, pero con la columna
// "Fecha de entrega <Mes>" que cambia de nombre cada mes (Trampa 4).
// ---------------------------------------------------------------------

const MAPA_OC: Record<string, string> = {
  "Documento compras": "purchaseDoc",
  Posición: "lineNumber",
  Posicion: "lineNumber",
  Proveedor: "vendorCode",
  "Nombre de Proveedor": "vendorName",
  Artículo: "sku",
  "Texto breve": "description",
  División: "division",
  "Cantidad de reparto": "allocatedQty",
  "Unidad medida pedido": "uom",
  "Cantidad entregada": "deliveredQty",
  "Fill Rate": "fillRate",
  "Estatus de OC": "poStatus",
  Negociador: "buyer",
  "Pedido en UMA": "orderInUMA",
  "CI Docto Compras": "purchaseDocRef",
  CPFR: "cpfr",
};

function parseFillRate(matriz: Celda[][], reg: Registrador): CuerpoHoja {
  const encabezados = matriz[0] ?? [];
  const ancho = anchoTabla(encabezados);
  if (ancho === 0) {
    reg.agregar("La hoja no tiene encabezados en la fila 1");
    return { read: 0, rejected: 0, docs: [] };
  }

  const { dims } = clasificarColumnas(encabezados, ancho, MAPA_OC, reg, {
    prefijos: [
      { prefijo: "Fecha de entrega", field: "deliveryDate" },
      { prefijo: "Fecha de pedido", field: "orderDate" },
    ],
  });

  const sinMarca = new MarcasSinClasificar();
  const docs: Record<string, unknown>[] = [];
  let read = 0;
  let rejected = 0;

  for (let r = 1; r < matriz.length; r++) {
    const row = matriz[r] ?? [];
    if (filaVacia(row, ancho)) break;
    read++;
    const get = lectorDeFila(row, dims);

    const description = toText(get("description"));
    const { brand, clasificada } = derivarMarca(description);
    if (!clasificada) sinMarca.registrar(description);

    const doc = {
      purchaseDoc: toCode(get("purchaseDoc")),
      lineNumber: toNumber(get("lineNumber")),
      vendorCode: toCode(get("vendorCode")),
      vendorName: toText(get("vendorName")),
      sku: toCode(get("sku")),
      description,
      brand,
      division: toText(get("division")),
      orderDate: parseCellDate(get("orderDate")),
      allocatedQty: toNumber(get("allocatedQty")),
      uom: toText(get("uom")),
      deliveredQty: toNumber(get("deliveredQty")),
      deliveryDate: parseCellDate(get("deliveryDate")),
      fillRate: toNumber(get("fillRate")), // fracción: 1 = 100%
      poStatus: toText(get("poStatus")),
      buyer: toText(get("buyer")),
      orderInUMA: toNumber(get("orderInUMA")),
      purchaseDocRef: toText(get("purchaseDocRef")),
      cpfr: toText(get("cpfr")),
    };

    const check = lineaOcRowSchema.safeParse(doc);
    if (!check.success) {
      rejected++;
      reg.agregar(`Fila rechazada: ${primerError(check.error)}`, r + 1);
      continue;
    }
    docs.push(doc);
  }

  sinMarca.volcar(reg);
  return { read, rejected, docs };
}

// ---------------------------------------------------------------------
// Inv Farma: 22 columnas fijas. Ojo: aquí "Proveedor " es el NÚMERO de
// proveedor y "Nombre proveedor " es el nombre.
// ---------------------------------------------------------------------

const MAPA_FARMA: Record<string, string> = {
  ID: "compositeId",
  "Ce.": "storeCode",
  "Nombre de Farmacia": "storeName",
  Artículo: "sku",
  "Texto breve de artículo": "description",
  División: "division",
  Proveedor: "vendorCode",
  "Nombre vendorName": "vendorName",
  "Tipo de Artículo": "itemType",
  ABC: "abc",
  SM: "sm",
  CaP: "cap",
  "Stock seg.mín.": "minSafetyStock",
  CobertObjMín: "minTargetCoverage",
  "Stock objetivo": "targetStock",
  "Punto pedido": "reorderPoint",
  "Stock dinámico": "dynamicStock",
  "Stock máximo": "maxStock",
  "Libre utiliz.": "unrestrictedStock",
  "Tránsito Farma": "pharmacyInTransit",
  "Selling Class": "sellingClass",
  "Nivel de inventario": "inventoryLevel",
};

function parseInvFarma(matriz: Celda[][], reg: Registrador): CuerpoHoja {
  const encabezados = matriz[0] ?? [];
  const ancho = anchoTabla(encabezados);
  if (ancho === 0) {
    reg.agregar("La hoja no tiene encabezados en la fila 1");
    return { read: 0, rejected: 0, docs: [] };
  }

  const { dims } = clasificarColumnas(encabezados, ancho, MAPA_FARMA, reg);
  const sinMarca = new MarcasSinClasificar();
  const docs: Record<string, unknown>[] = [];
  let read = 0;
  let rejected = 0;

  for (let r = 1; r < matriz.length; r++) {
    const row = matriz[r] ?? [];
    if (filaVacia(row, ancho)) break;
    read++;
    const get = lectorDeFila(row, dims);

    const description = toText(get("description"));
    const { brand, clasificada } = derivarMarca(description);
    if (!clasificada) sinMarca.registrar(description);

    const doc = {
      compositeId: toCode(get("compositeId")),
      storeCode: toCodigoTienda(get("storeCode")),
      storeName: toText(get("storeName")),
      sku: toCode(get("sku")),
      description,
      brand,
      division: toText(get("division")),
      vendorCode: toCode(get("vendorCode")),
      vendorName: toText(get("vendorName")),
      itemType: toText(get("itemType")),
      abc: toText(get("abc")),
      sm: toText(get("sm")),
      cap: toText(get("cap")),
      minSafetyStock: toNumber(get("minSafetyStock")),
      minTargetCoverage: toNumber(get("minTargetCoverage")),
      targetStock: toNumber(get("targetStock")),
      reorderPoint: toNumber(get("reorderPoint")),
      dynamicStock: toNumber(get("dynamicStock")),
      maxStock: toNumber(get("maxStock")),
      unrestrictedStock: toNumber(get("unrestrictedStock")),
      pharmacyInTransit: toNumber(get("pharmacyInTransit")),
      sellingClass: toNumber(get("sellingClass")),
      inventoryLevel: toNumber(get("inventoryLevel")),
    };

    const check = farmaciaRowSchema.safeParse(doc);
    if (!check.success) {
      rejected++;
      reg.agregar(`Fila rechazada: ${primerError(check.error)}`, r + 1);
      continue;
    }
    validarIdCompuesto(doc, r + 1, reg);
    docs.push(doc);
  }

  sinMarca.volcar(reg);
  return { read, rejected, docs };
}

// ---------------------------------------------------------------------

export function parseWorkbook(data: Buffer | Uint8Array): ResultadoParseo {
  const wb = XLSX.read(data, { dense: true, cellDates: true });
  const hojas: HojaParseada[] = [];

  for (const name of wb.SheetNames) {
    const reg = new Registrador(name);
    const tipo = tipoDeHoja(name);

    if (!tipo) {
      // Hoja no reconocida: no falla la carga, se registra y se ignora (§7.2).
      reg.agregar("Hoja no mapeada, ignorada");
      hojas.push({ name, tipo: null, read: 0, rejected: 0, issues: reg.issues, docs: [] });
      continue;
    }

    const matriz = leerMatriz(wb.Sheets[name]);
    let cuerpo: CuerpoHoja;
    switch (tipo) {
      case "cedis":
        cuerpo = parseCedis(matriz, reg);
        break;
      case "fillRate":
        cuerpo = parseFillRate(matriz, reg);
        break;
      case "invFarma":
        cuerpo = parseInvFarma(matriz, reg);
        break;
      default:
        cuerpo = parseHojaLarga(matriz, tipo, reg);
    }

    reg.cerrar();
    hojas.push({ name, tipo, ...cuerpo, issues: reg.issues });
    // Se procesa una hoja a la vez, liberando la anterior (§7).
    delete wb.Sheets[name];
  }

  return { hojas };
}

// Export para tests: schema base de las hojas largas.
export { baseLargaSchema };
