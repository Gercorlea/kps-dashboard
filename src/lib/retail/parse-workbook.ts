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
  hoja: string;
  fila?: number;
  campo?: string;
  mensaje: string;
}

export type TipoHoja =
  | "cedis"
  | "ventas"
  | "pronosticos"
  | "fcMean"
  | "fillRate"
  | "invFarma";

export interface HojaParseada {
  nombre: string;
  tipo: TipoHoja | null;
  leidas: number;
  rechazadas: number;
  incidencias: IncidenciaParseo[];
  docs: Record<string, unknown>[];
}

export interface ResultadoParseo {
  hojas: HojaParseada[];
}

// Más allá de 100 incidencias por hoja solo se conserva el conteo (§7.5).
const MAX_INCIDENCIAS_POR_HOJA = 100;

const TIPO_POR_NOMBRE: Record<string, TipoHoja> = {
  CEDIS: "cedis",
  VENTAS: "ventas",
  PRONOSTICOS: "pronosticos",
  FC_MEAN: "fcMean",
  "FC MEAN": "fcMean",
  "FILL RATE": "fillRate",
  "INV FARMA": "invFarma",
};

// Reconocimiento por nombre normalizado, tolerando mayúsculas, espacios
// y acentos ("PRONÓSTICOS" → PRONOSTICOS) (§7.2).
export function tipoDeHoja(nombre: string): TipoHoja | null {
  const clave = normHeader(nombre)
    .toUpperCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
  return TIPO_POR_NOMBRE[clave] ?? null;
}

class Registrador {
  incidencias: IncidenciaParseo[] = [];
  private omitidas = 0;

  constructor(private hoja: string) {}

  agregar(mensaje: string, fila?: number, campo?: string) {
    if (this.incidencias.length >= MAX_INCIDENCIAS_POR_HOJA) {
      this.omitidas++;
      return;
    }
    this.incidencias.push({
      hoja: this.hoja,
      ...(fila !== undefined ? { fila } : {}),
      ...(campo ? { campo } : {}),
      mensaje,
    });
  }

  cerrar() {
    if (this.omitidas > 0) {
      this.incidencias.push({
        hoja: this.hoja,
        mensaje: `…y ${this.omitidas} incidencias más (solo se registran las primeras ${MAX_INCIDENCIAS_POR_HOJA}).`,
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
// de la tabla; no confiar en sheet['!ref'].
function filaVacia(fila: Celda[], ancho: number): boolean {
  for (let c = 0; c < ancho; c++) {
    const v = fila[c];
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
  fecha: Date;
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
    prefijos?: Array<{ prefijo: string; campo: string }>;
  }
): Clasificacion {
  const dims: Record<string, number> = {};
  const fechas: ColumnaFecha[] = [];

  for (let c = 0; c < ancho; c++) {
    const bruto = encabezados[c];
    const fecha = parseHeaderDate(bruto);
    if (fecha) {
      fechas.push({ col: c, fecha });
      continue;
    }
    const h = normHeader(bruto);
    if (opciones?.excluir?.(h)) continue;
    // Trampa 4: columnas con el mes hardcodeado se mapean por prefijo.
    const porPrefijo = opciones?.prefijos?.find((p) => h.startsWith(p.prefijo));
    if (porPrefijo) {
      dims[porPrefijo.campo] = c;
      continue;
    }
    const campo = mapa[h];
    if (campo !== undefined) {
      dims[campo] = c;
      continue;
    }
    reg.agregar(`Columna no reconocida, ignorada: "${h}"`, 1);
  }

  // Si un encabezado esperado no aparece, no truena la carga: incidencia,
  // campo en null y seguimos (Trampa 4).
  const esperados = new Map<string, string>();
  for (const [nombre, campo] of Object.entries(mapa)) {
    if (!esperados.has(campo)) esperados.set(campo, nombre);
  }
  for (const p of opciones?.prefijos ?? []) {
    if (!esperados.has(p.campo)) esperados.set(p.campo, `${p.prefijo}…`);
  }
  for (const [campo, nombre] of esperados) {
    if (!(campo in dims)) {
      reg.agregar(
        `Columna esperada no encontrada: "${nombre}" — el campo ${campo} quedará vacío`,
        1,
        campo
      );
    }
  }

  return { dims, fechas };
}

type Lector = (campo: string) => Celda;

function lectorDeFila(fila: Celda[], dims: Record<string, number>): Lector {
  return (campo: string) => {
    const c = dims[campo];
    return c === undefined ? null : fila[c];
  };
}

// Las marcas sin clasificar se agrupan por descripción única para que la
// UI muestre conteo y lista, sin registrar miles de incidencias (§7.3).
class MarcasSinClasificar {
  private mapa = new Map<string, number>();

  registrar(descripcion: string) {
    if (!descripcion) return;
    this.mapa.set(descripcion, (this.mapa.get(descripcion) ?? 0) + 1);
  }

  volcar(reg: Registrador) {
    for (const [descripcion, filas] of this.mapa) {
      reg.agregar(`Marca sin clasificar (${filas} filas): "${descripcion}"`, undefined, "marca");
    }
  }
}

function validarIdCompuesto(
  doc: { idCompuesto: string; codigoTienda: string; sku: string },
  fila: number,
  reg: Registrador
) {
  if (!doc.idCompuesto || !doc.codigoTienda || !doc.sku) return;
  const esperado = `${doc.codigoTienda}${doc.sku}`;
  // Excel guarda el ID como número y pierde el cero inicial de la tienda
  // ("0141" + "70890001" → 14170890001): comparar con ceros normalizados.
  if (doc.idCompuesto.padStart(esperado.length, "0") !== esperado) {
    reg.agregar(
      `ID compuesto inconsistente: "${doc.idCompuesto}" ≠ tienda "${doc.codigoTienda}" + SKU "${doc.sku}"`,
      fila,
      "idCompuesto"
    );
  }
}

interface CuerpoHoja {
  leidas: number;
  rechazadas: number;
  docs: Record<string, unknown>[];
}

// ---------------------------------------------------------------------
// VENTAS / PRONOSTICOS / FC_Mean: mismas dimensiones + columnas de fecha
// dinámicas al final. Se desnormalizan (unpivot) a documentos individuales
// { …dimensiones, fecha, valor } (§6.1).
// ---------------------------------------------------------------------

const MAPA_LARGO: Record<string, string> = {
  "Ubic.": "codigoTienda",
  "Nombre de Farmacias": "nombreTienda",
  "Prod.": "sku",
  ID: "idCompuesto",
  Descripción: "descripcion",
  División: "division",
  "Num Proveedor": "numProveedor",
  Proveedor: "proveedor",
};

const baseLargaSchema = ventaRowSchema.omit({ fecha: true, unidades: true });

function parseHojaLarga(
  matriz: Celda[][],
  tipo: "ventas" | "pronosticos" | "fcMean",
  reg: Registrador
): CuerpoHoja {
  const encabezados = matriz[0] ?? [];
  const ancho = anchoTabla(encabezados);
  if (ancho === 0) {
    reg.agregar("La hoja no tiene encabezados en la fila 1");
    return { leidas: 0, rechazadas: 0, docs: [] };
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

  const campoFecha = tipo === "pronosticos" ? "semanaInicio" : "fecha";
  const campoValor = tipo === "ventas" ? "unidades" : "valor";
  const sinMarca = new MarcasSinClasificar();
  const docs: Record<string, unknown>[] = [];
  let leidas = 0;
  let rechazadas = 0;

  for (let r = 1; r < matriz.length; r++) {
    const fila = matriz[r] ?? [];
    if (filaVacia(fila, ancho)) break;
    leidas++;
    const get = lectorDeFila(fila, dims);

    const descripcion = toText(get("descripcion"));
    const { marca, clasificada } = derivarMarca(descripcion);
    if (!clasificada) sinMarca.registrar(descripcion);

    const base = {
      codigoTienda: toCodigoTienda(get("codigoTienda")),
      nombreTienda: toText(get("nombreTienda")),
      sku: toCode(get("sku")),
      idCompuesto: toCode(get("idCompuesto")),
      descripcion,
      marca,
      division: toText(get("division")),
      numProveedor: toCode(get("numProveedor")),
      proveedor: toText(get("proveedor")),
    };

    const check = baseLargaSchema.safeParse(base);
    if (!check.success) {
      rechazadas++;
      reg.agregar(`Fila rechazada: ${primerError(check.error)}`, r + 1);
      continue;
    }
    validarIdCompuesto(base, r + 1, reg);

    for (const { col, fecha } of fechas) {
      const valor = toNumber(fila[col]);
      if (valor === null) continue; // ausente ≠ 0 (§7.5)
      docs.push({ ...base, [campoFecha]: fecha, [campoValor]: valor });
    }
  }

  sinMarca.volcar(reg);
  return { leidas, rechazadas, docs };
}

// ---------------------------------------------------------------------
// CEDIS: fechas de citas EN MEDIO de la tabla, unpivot embebido en `citas`.
// ---------------------------------------------------------------------

const MAPA_CEDIS: Record<string, string> = {
  Artículo: "sku",
  "Texto breve de artículo": "descripcion",
  División: "division",
  "Num Proveedor": "numProveedor",
  Proveedor: "proveedor",
  "Disponibilidad Real CD": "disponibilidadRealCD",
  Tránsitos: "transitos",
  Transitos: "transitos",
  "SIN CITA": "sinCita",
  "Caracteristica de plan": "caracteristicaPlan",
  "Característica de plan": "caracteristicaPlan",
  Mínimo: "minimo",
  Minimo: "minimo",
  Cobertura: "cobertura",
  "Punto de Pedido": "puntoPedido",
  "Stock Objetivo": "stockObjetivo",
};

function parseCedis(matriz: Celda[][], reg: Registrador): CuerpoHoja {
  const encabezados = matriz[0] ?? [];
  const ancho = anchoTabla(encabezados);
  if (ancho === 0) {
    reg.agregar("La hoja no tiene encabezados en la fila 1");
    return { leidas: 0, rechazadas: 0, docs: [] };
  }

  const { dims, fechas } = clasificarColumnas(encabezados, ancho, MAPA_CEDIS, reg);
  const sinMarca = new MarcasSinClasificar();
  const docs: Record<string, unknown>[] = [];
  let leidas = 0;
  let rechazadas = 0;

  for (let r = 1; r < matriz.length; r++) {
    const fila = matriz[r] ?? [];
    if (filaVacia(fila, ancho)) break;
    leidas++;
    const get = lectorDeFila(fila, dims);

    const descripcion = toText(get("descripcion"));
    const { marca, clasificada } = derivarMarca(descripcion);
    if (!clasificada) sinMarca.registrar(descripcion);

    const citas: Array<{ fecha: Date; cantidad: number }> = [];
    for (const { col, fecha } of fechas) {
      const cantidad = toNumber(fila[col]);
      if (cantidad === null) continue;
      citas.push({ fecha, cantidad });
    }

    const doc = {
      sku: toCode(get("sku")),
      descripcion,
      marca,
      division: toText(get("division")),
      numProveedor: toCode(get("numProveedor")),
      proveedor: toText(get("proveedor")),
      disponibilidadRealCD: toNumber(get("disponibilidadRealCD")),
      transitos: toNumber(get("transitos")),
      sinCita: toNumber(get("sinCita")),
      citas,
      caracteristicaPlan: toText(get("caracteristicaPlan")), // "21" y "ND" → string
      minimo: toNumber(get("minimo")),
      cobertura: toNumber(get("cobertura")),
      puntoPedido: toNumber(get("puntoPedido")),
      stockObjetivo: toNumber(get("stockObjetivo")),
    };

    const check = cedisRowSchema.safeParse(doc);
    if (!check.success) {
      rechazadas++;
      reg.agregar(`Fila rechazada: ${primerError(check.error)}`, r + 1);
      continue;
    }
    docs.push(doc);
  }

  sinMarca.volcar(reg);
  return { leidas, rechazadas, docs };
}

// ---------------------------------------------------------------------
// Fill Rate: 18 columnas fijas, sin fechas dinámicas, pero con la columna
// "Fecha de entrega <Mes>" que cambia de nombre cada mes (Trampa 4).
// ---------------------------------------------------------------------

const MAPA_OC: Record<string, string> = {
  "Documento compras": "documentoCompras",
  Posición: "posicion",
  Posicion: "posicion",
  Proveedor: "numProveedor",
  "Nombre de Proveedor": "nombreProveedor",
  Artículo: "sku",
  "Texto breve": "descripcion",
  División: "division",
  "Cantidad de reparto": "cantidadReparto",
  "Unidad medida pedido": "unidadMedida",
  "Cantidad entregada": "cantidadEntregada",
  "Fill Rate": "fillRate",
  "Estatus de OC": "estatusOC",
  Negociador: "negociador",
  "Pedido en UMA": "pedidoEnUMA",
  "CI Docto Compras": "ciDoctoCompras",
  CPFR: "cpfr",
};

function parseFillRate(matriz: Celda[][], reg: Registrador): CuerpoHoja {
  const encabezados = matriz[0] ?? [];
  const ancho = anchoTabla(encabezados);
  if (ancho === 0) {
    reg.agregar("La hoja no tiene encabezados en la fila 1");
    return { leidas: 0, rechazadas: 0, docs: [] };
  }

  const { dims } = clasificarColumnas(encabezados, ancho, MAPA_OC, reg, {
    prefijos: [
      { prefijo: "Fecha de entrega", campo: "fechaEntrega" },
      { prefijo: "Fecha de pedido", campo: "fechaPedido" },
    ],
  });

  const sinMarca = new MarcasSinClasificar();
  const docs: Record<string, unknown>[] = [];
  let leidas = 0;
  let rechazadas = 0;

  for (let r = 1; r < matriz.length; r++) {
    const fila = matriz[r] ?? [];
    if (filaVacia(fila, ancho)) break;
    leidas++;
    const get = lectorDeFila(fila, dims);

    const descripcion = toText(get("descripcion"));
    const { marca, clasificada } = derivarMarca(descripcion);
    if (!clasificada) sinMarca.registrar(descripcion);

    const doc = {
      documentoCompras: toCode(get("documentoCompras")),
      posicion: toNumber(get("posicion")),
      numProveedor: toCode(get("numProveedor")),
      nombreProveedor: toText(get("nombreProveedor")),
      sku: toCode(get("sku")),
      descripcion,
      marca,
      division: toText(get("division")),
      fechaPedido: parseCellDate(get("fechaPedido")),
      cantidadReparto: toNumber(get("cantidadReparto")),
      unidadMedida: toText(get("unidadMedida")),
      cantidadEntregada: toNumber(get("cantidadEntregada")),
      fechaEntrega: parseCellDate(get("fechaEntrega")),
      fillRate: toNumber(get("fillRate")), // fracción: 1 = 100%
      estatusOC: toText(get("estatusOC")),
      negociador: toText(get("negociador")),
      pedidoEnUMA: toNumber(get("pedidoEnUMA")),
      ciDoctoCompras: toText(get("ciDoctoCompras")),
      cpfr: toText(get("cpfr")),
    };

    const check = lineaOcRowSchema.safeParse(doc);
    if (!check.success) {
      rechazadas++;
      reg.agregar(`Fila rechazada: ${primerError(check.error)}`, r + 1);
      continue;
    }
    docs.push(doc);
  }

  sinMarca.volcar(reg);
  return { leidas, rechazadas, docs };
}

// ---------------------------------------------------------------------
// Inv Farma: 22 columnas fijas. Ojo: aquí "Proveedor " es el NÚMERO de
// proveedor y "Nombre proveedor " es el nombre.
// ---------------------------------------------------------------------

const MAPA_FARMA: Record<string, string> = {
  ID: "idCompuesto",
  "Ce.": "codigoTienda",
  "Nombre de Farmacia": "nombreTienda",
  Artículo: "sku",
  "Texto breve de artículo": "descripcion",
  División: "division",
  Proveedor: "numProveedor",
  "Nombre proveedor": "nombreProveedor",
  "Tipo de Artículo": "tipoArticulo",
  ABC: "abc",
  SM: "sm",
  CaP: "cap",
  "Stock seg.mín.": "stockSegMin",
  CobertObjMín: "cobertObjMin",
  "Stock objetivo": "stockObjetivo",
  "Punto pedido": "puntoPedido",
  "Stock dinámico": "stockDinamico",
  "Stock máximo": "stockMaximo",
  "Libre utiliz.": "libreUtilizacion",
  "Tránsito Farma": "transitoFarma",
  "Selling Class": "sellingClass",
  "Nivel de inventario": "nivelInventario",
};

function parseInvFarma(matriz: Celda[][], reg: Registrador): CuerpoHoja {
  const encabezados = matriz[0] ?? [];
  const ancho = anchoTabla(encabezados);
  if (ancho === 0) {
    reg.agregar("La hoja no tiene encabezados en la fila 1");
    return { leidas: 0, rechazadas: 0, docs: [] };
  }

  const { dims } = clasificarColumnas(encabezados, ancho, MAPA_FARMA, reg);
  const sinMarca = new MarcasSinClasificar();
  const docs: Record<string, unknown>[] = [];
  let leidas = 0;
  let rechazadas = 0;

  for (let r = 1; r < matriz.length; r++) {
    const fila = matriz[r] ?? [];
    if (filaVacia(fila, ancho)) break;
    leidas++;
    const get = lectorDeFila(fila, dims);

    const descripcion = toText(get("descripcion"));
    const { marca, clasificada } = derivarMarca(descripcion);
    if (!clasificada) sinMarca.registrar(descripcion);

    const doc = {
      idCompuesto: toCode(get("idCompuesto")),
      codigoTienda: toCodigoTienda(get("codigoTienda")),
      nombreTienda: toText(get("nombreTienda")),
      sku: toCode(get("sku")),
      descripcion,
      marca,
      division: toText(get("division")),
      numProveedor: toCode(get("numProveedor")),
      nombreProveedor: toText(get("nombreProveedor")),
      tipoArticulo: toText(get("tipoArticulo")),
      abc: toText(get("abc")),
      sm: toText(get("sm")),
      cap: toText(get("cap")),
      stockSegMin: toNumber(get("stockSegMin")),
      cobertObjMin: toNumber(get("cobertObjMin")),
      stockObjetivo: toNumber(get("stockObjetivo")),
      puntoPedido: toNumber(get("puntoPedido")),
      stockDinamico: toNumber(get("stockDinamico")),
      stockMaximo: toNumber(get("stockMaximo")),
      libreUtilizacion: toNumber(get("libreUtilizacion")),
      transitoFarma: toNumber(get("transitoFarma")),
      sellingClass: toNumber(get("sellingClass")),
      nivelInventario: toNumber(get("nivelInventario")),
    };

    const check = farmaciaRowSchema.safeParse(doc);
    if (!check.success) {
      rechazadas++;
      reg.agregar(`Fila rechazada: ${primerError(check.error)}`, r + 1);
      continue;
    }
    validarIdCompuesto(doc, r + 1, reg);
    docs.push(doc);
  }

  sinMarca.volcar(reg);
  return { leidas, rechazadas, docs };
}

// ---------------------------------------------------------------------

export function parseWorkbook(data: Buffer | Uint8Array): ResultadoParseo {
  const wb = XLSX.read(data, { dense: true, cellDates: true });
  const hojas: HojaParseada[] = [];

  for (const nombre of wb.SheetNames) {
    const reg = new Registrador(nombre);
    const tipo = tipoDeHoja(nombre);

    if (!tipo) {
      // Hoja no reconocida: no falla la carga, se registra y se ignora (§7.2).
      reg.agregar("Hoja no mapeada, ignorada");
      hojas.push({ nombre, tipo: null, leidas: 0, rechazadas: 0, incidencias: reg.incidencias, docs: [] });
      continue;
    }

    const matriz = leerMatriz(wb.Sheets[nombre]);
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
    hojas.push({ nombre, tipo, ...cuerpo, incidencias: reg.incidencias });
    // Se procesa una hoja a la vez, liberando la anterior (§7).
    delete wb.Sheets[nombre];
  }

  return { hojas };
}

// Export para tests: schema base de las hojas largas.
export { baseLargaSchema };
