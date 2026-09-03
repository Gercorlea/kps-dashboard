// Capa de consultas de SOLO LECTURA sobre el Service Layer, pensada para
// exponerse como herramienta a KPS AI. Reglas:
//  - GET por construcción: jamás se pasa method/body a sapFetch.
//  - Cualquier entity set del Service Layer (son ~332), salvo Login/Logout.
//  - $top acotado y $select por defecto para no reventar tokens.
import { camposPorDefecto, nombreEntidad } from "./campos";
import { enriquecerFrescura } from "./frescura";
import { sapFetch, sapFetchV2 } from "./service-layer";

// Las más usadas, para orientar al modelo. NO es una lista de permisos:
// consultarSap acepta cualquier entity set que exista en SAP.
export const ENTIDADES_SAP = [
  "Items",
  "BusinessPartners",
  "Orders",
  "Invoices",
  "Quotations",
  "PurchaseOrders",
  "PurchaseInvoices",
  "DeliveryNotes",
  "CreditNotes",
  "Warehouses",
  "PriceLists",
  "ItemGroups",
] as const;

// Manipulan la sesión que cachea service-layer.ts; dejarlas pasar la rompería.
const PROHIBIDAS = new Set(["login", "logout"]);

const TOP_MAX = 100;

// Colecciones anidadas (DocumentLines, ItemPrices, BatchNumbers…): SAP
// devuelve ~150 campos por línea. 52 órdenes con sus líneas completas fueron
// ~280K tokens y reventaron la ventana del modelo (200K). Se dejan solo los
// campos de negocio, sin nulos ni vacíos, y como mucho LINEAS_MAX por fila.
const LINEAS_MAX = 40;
const CAMPOS_LINEA = new Set([
  "LineNum", "ItemCode", "ItemDescription", "Quantity", "RemainingOpenQuantity",
  "OpenAmount", "Price", "UnitPrice", "PriceAfterVAT", "LineTotal", "Currency",
  "LineStatus", "WarehouseCode", "ShipDate", "DiscountPercent", "MeasureUnit",
  "UoMCode", "BaseEntry", "BaseLine", "PriceList", "BatchNumber", "ExpiryDate",
  "TaxCode", "VatGroup",
]);

function vacio(v: unknown): boolean {
  return v === null || v === undefined || v === "";
}

function compactarLinea(linea: Record<string, unknown>): Record<string, unknown> {
  const conocidos = Object.entries(linea).filter(([k, v]) => CAMPOS_LINEA.has(k) && !vacio(v));
  if (conocidos.length > 0) return Object.fromEntries(conocidos);
  // Colección que no conocemos: los primeros campos con valor, para no cegar al modelo.
  return Object.fromEntries(Object.entries(linea).filter(([, v]) => !vacio(v) && typeof v !== "object").slice(0, 8));
}

/** Recorta cada colección anidada de una fila a sus campos de negocio y a LINEAS_MAX renglones. */
export function compactarAnidados(fila: Record<string, unknown>): Record<string, unknown> {
  const salida: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fila)) {
    if (Array.isArray(v) && v.length > 0 && v.every((x) => x && typeof x === "object" && !Array.isArray(x))) {
      const lineas = (v as Record<string, unknown>[]).slice(0, LINEAS_MAX).map(compactarLinea);
      salida[k] = lineas;
      if (v.length > LINEAS_MAX) salida[`${k}Omitidas`] = v.length - LINEAS_MAX;
    } else {
      salida[k] = v;
    }
  }
  return salida;
}

export interface ConsultaSap {
  entidad: string; // entity set del Service Layer, ej: "Items", "ChartOfAccounts"
  filtro?: string; // $filter OData, ej: "ItemCode eq '70006147'"
  campos?: string[]; // $select; si se omite se usan los campos clave de la entidad
  ordenarPor?: string; // $orderby, ej: "DocDate desc"
  top?: number; // máx TOP_MAX
  saltar?: number; // $skip: para recorrer un catálogo entero en varias llamadas
}

export interface ResultadoConsultaSap {
  total: number | null; // conteo total en SAP (odata.count)
  devueltas: number;
  filas: Record<string, unknown>[];
  campos?: string; // qué $select se aplicó, cuando fue el de por defecto
}

export async function consultarSap(consulta: ConsultaSap): Promise<ResultadoConsultaSap> {
  const entidad = consulta.entidad.trim().replace(/^\/+/, "");
  if (!entidad || entidad.includes("..") || PROHIBIDAS.has(nombreEntidad(entidad))) {
    throw new Error(`Entidad no permitida: ${consulta.entidad}`);
  }

  // Sin $select explícito, pedimos los campos clave: SAP devuelve la entidad
  // completa (311 campos en Items) y eso se come la ventana de contexto.
  const porDefecto = consulta.campos?.length ? undefined : camposPorDefecto(entidad);
  let select = consulta.campos?.length ? consulta.campos.join(",") : porDefecto;

  // `Cancelled` se cuela SIEMPRE en los documentos, aunque pidan campos
  // concretos. Una cancelada conserva DocumentStatus 'bost_Close', así que sin
  // este campo las filas parecen cerradas normales: pidiendo
  // DocNum/DocDate/DocTotal/DocumentStatus se respondió que 12 de 13 facturas
  // de Coppel estaban canceladas cuando son 6.
  if (select && DOCS_CANCELABLES.has(nombreEntidad(entidad)) && !/\bCancelled\b/.test(select)) {
    select = `${select},Cancelled`;
  }

  // EL FOLIO NO ES CRONOLÓGICO: las facturas de 2025 llevan folios compuestos
  // (226642025 = consecutivo + año) numéricamente mayores que los de 2026
  // (7248), así que "DocNum desc" devuelve las MÁS VIEJAS. Avisar no bastaba —
  // el modelo leía la nota y presentaba igual las de 2025-12-31 como "las
  // últimas", contradiciendo lo que él mismo había respondido ordenando por
  // fecha—, así que se corrige el orden y se dice en la respuesta.
  let ordenarPor = consulta.ordenarPor;
  let ordenCorregido: string | null = null;
  if (
    ordenarPor &&
    DOCS_CANCELABLES.has(nombreEntidad(entidad)) &&
    /^\s*Doc(Num|Entry)\b/i.test(ordenarPor)
  ) {
    const direccion = /\bdesc\b/i.test(ordenarPor) ? "desc" : "asc";
    ordenCorregido = ordenarPor;
    ordenarPor = `DocDate ${direccion}, DocNum ${direccion}`;
  }

  const params = new URLSearchParams();
  if (consulta.filtro) params.set("$filter", consulta.filtro);
  if (select) params.set("$select", select);
  if (ordenarPor) params.set("$orderby", ordenarPor);
  const top = Math.min(Math.max(consulta.top ?? 10, 1), TOP_MAX);
  params.set("$top", String(top));
  if (consulta.saltar && consulta.saltar > 0) params.set("$skip", String(Math.floor(consulta.saltar)));
  params.set("$inlinecount", "allpages");

  const data = await sapFetch<{
    value?: Record<string, unknown>[];
    "odata.count"?: string | number;
    "@odata.count"?: number;
  }>(`/${entidad}?${params.toString()}`, {
    // El Service Layer pagina de 20 en 20 (PageSize de b1s.conf) y devuelve
    // odata.nextLink; sin esta cabecera un $top mayor solo trae 20 filas.
    headers: { Prefer: `odata.maxpagesize=${top}` },
  });

  // Lotes: los días de frescura se calculan aquí, nunca los resta el modelo.
  const crudas = data.value ?? [];
  const resumenLineas = resumirLineas(crudas);
  const filas = enriquecerFrescura(crudas).map(compactarAnidados);
  const bruto = data["odata.count"] ?? data["@odata.count"];
  const total = bruto === undefined ? null : Number(bruto);
  const resumenDocumentos = resumirDocumentos(crudas, filas.length, Number.isFinite(total) ? total : null);

  // EL FOLIO NO ES CRONOLÓGICO. Las facturas de 2025 llevan folios compuestos
  // (226642025 = consecutivo + año) que son numéricamente mayores que los de
  // 2026 (7248), así que "ordenarPor DocNum desc" devuelve las MÁS VIEJAS.
  // Medido: en la misma conversación, "las últimas 5 facturas" dio Costco del
  // 2026-07-24 ordenando por DocDate y, al pedir el reporte, ordenó por DocNum
  // y el PDF salió con las del 2025-12-31 contradiciendo al chat.
  return {
    ...(ordenCorregido
      ? {
          ordenAplicado: ordenarPor,
          notaOrden:
            `Pediste ordenar por "${ordenCorregido}", pero el folio NO es cronológico en esta base: las ` +
            "facturas de 2025 usan folios compuestos (226642025) mayores que los de 2026 (7248), así que " +
            `ese orden devuelve las más ANTIGUAS. Se aplicó "${ordenarPor}" en su lugar, que es lo que ` +
            "significa \"las últimas\". Estas filas SÍ son las más recientes por fecha.",
        }
      : {}),
    total: Number.isFinite(total) ? total : null,
    devueltas: filas.length,
    filas,
    ...(resumenDocumentos ? { resumenDocumentos } : {}),
    ...(porDefecto ? { campos: porDefecto } : {}),
    ...(resumenLineas ? { resumenLineas } : {}),
  };
}

// Sumas de las colecciones anidadas calculadas AQUÍ, sobre todas las líneas
// devueltas (antes del recorte a LINEAS_MAX) y por moneda del documento. El
// modelo sumaba 114 líneas a mano y se equivocaba (724,618 piezas en vez de
// 907,952): con esto reporta las cifras del servidor.
const CAMPOS_SUMABLES_LINEA = ["Quantity", "RemainingOpenQuantity", "OpenAmount", "LineTotal"] as const;

/**
 * Conteos e importes de una lista de DOCUMENTOS, calculados aquí. El modelo
 * sumaba las filas de su propia tabla y se equivocaba: con las 13 facturas de
 * Coppel delante dijo "5 canceladas" (son 6) y "27,922.16 facturado de verdad"
 * (son 29,340.91). Además avisa cuando la lista viene recortada, que es como
 * acabó extrapolando lo que no había visto.
 */
function resumirDocumentos(
  filas: Record<string, unknown>[],
  devueltas: number,
  total: number | null
): Record<string, unknown> | null {
  if (!filas.length || !("DocTotal" in filas[0])) return null;
  const acum = { vigentes: { n: 0, importe: 0 }, cancelados: { n: 0, importe: 0 }, abiertos: { n: 0, importe: 0 } };
  for (const f of filas) {
    const v = Number(f.DocTotal);
    if (!Number.isFinite(v)) continue;
    if (f.Cancelled === "tYES") {
      acum.cancelados.n++;
      acum.cancelados.importe += v;
      continue; // un cancelado no es facturación: no entra en vigentes
    }
    acum.vigentes.n++;
    acum.vigentes.importe += v;
    if (f.DocumentStatus === "bost_Open") {
      acum.abiertos.n++;
      acum.abiertos.importe += v;
    }
  }
  const r = (x: number) => Math.round(x * 100) / 100;
  const parcial = total !== null && devueltas < total;
  return {
    documentos: filas.length,
    vigentes: { documentos: acum.vigentes.n, importe: r(acum.vigentes.importe) },
    cancelados: { documentos: acum.cancelados.n, importe: r(acum.cancelados.importe) },
    abiertos: { documentos: acum.abiertos.n, importe: r(acum.abiertos.importe) },
    nota:
      (parcial
        ? `CUIDADO: esto resume sólo los ${devueltas} documentos devueltos de ${total} que hay. NO son ` +
          "los totales del cliente ni del periodo: sube `top` o usa agregar_sap antes de dar cifras. "
        : "Cubre los documentos devueltos, que son todos los del filtro. ") +
      "Los importes ya están sumados aquí: úsalos tal cual, no sumes las filas. `vigentes` excluye los " +
      "CANCELADOS, que conservan estado 'bost_Close' pero no son facturación real.",
  };
}

export function resumirLineas(filas: Record<string, unknown>[]): Record<string, unknown> | null {
  const resumen: Record<string, unknown> = {};
  for (const [k] of Object.entries(filas[0] ?? {})) {
    let documentos = 0;
    let lineas = 0;
    const porMoneda: Record<string, Record<string, number>> = {};
    for (const fila of filas) {
      const v = fila[k];
      if (!Array.isArray(v) || v.length === 0 || !v.every((x) => x && typeof x === "object" && !Array.isArray(x))) continue;
      documentos++;
      const moneda = typeof fila.DocCurrency === "string" && fila.DocCurrency ? fila.DocCurrency : "total";
      const acum = (porMoneda[moneda] ??= {});
      for (const linea of v as Record<string, unknown>[]) {
        lineas++;
        for (const c of CAMPOS_SUMABLES_LINEA) {
          const n = Number(linea[c]);
          if (linea[c] !== null && linea[c] !== undefined && Number.isFinite(n)) acum[c] = (acum[c] ?? 0) + n;
        }
      }
    }
    if (lineas === 0) continue;
    for (const m of Object.values(porMoneda)) for (const c of Object.keys(m)) m[c] = Math.round(m[c] * 100) / 100;
    resumen[k] = {
      documentos,
      lineas,
      sumas: porMoneda,
      nota: "Sumas calculadas por el servidor sobre las filas devueltas: úsalas tal cual, no sumes líneas a mano. Cada moneda va por separado: NUNCA sumes MXP con USD en una sola cifra.",
    };
  }
  return Object.keys(resumen).length ? resumen : null;
}

// --- Agregación en el servidor (OData v4, /b1s/v2) ---------------------------
//
// Existe para que el modelo NUNCA responda un total o un ranking contando
// filas de una muestra: groupby/aggregate se ejecuta sobre TODO el entity set
// dentro de SAP y devuelve solo los grupos. Limitaciones verificadas en vivo:
//  - no acepta $filter ni filter() dentro de $apply → siempre es historia completa;
//  - no acepta $orderby sobre los alias del aggregate → se ordena aquí en JS;
//  - solo campos de CABECERA (DocumentLines no es agregable: para ventas por
//    artículo está la colección sapSales de consultar_retail).

export const OPERACIONES_AGREGADO = ["suma", "promedio", "max", "min"] as const;
export type OperacionAgregado = (typeof OPERACIONES_AGREGADO)[number];

const OPERACION_ODATA: Record<OperacionAgregado, string> = {
  suma: "sum",
  promedio: "average",
  max: "max",
  min: "min",
};

export interface AgregadoSap {
  entidad: string; // entity set de cabecera, ej: "Invoices", "Orders"
  filtro?: string; // $filter OData; con él la agregación se hace en el servidor Node paginando
  agruparPor?: string[]; // campos de agrupación; sin ellos, un total global
  metricas?: Array<{ campo: string; operacion: OperacionAgregado }>;
  top?: number; // grupos a devolver tras ordenar (defecto 20)
}

export interface ResultadoAgregadoSap {
  grupos: number; // cuántos grupos existen en total
  devueltas: number;
  filas: Record<string, unknown>[];
  filtro?: string; // el $filter aplicado (agregación filtrada)
  documentosConsiderados?: number; // filas leídas para la agregación filtrada
  truncado?: boolean; // true si se alcanzó el tope de filas y el total es parcial
}

const CAMPO_ODATA = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TOP_GRUPOS = 1000; // tope de grupos que se traen para ordenar en JS

// SAP no acepta $filter dentro de $apply, así que un total "de las abiertas"
// o "de julio" se calcula aquí: se pagina la entidad con $filter y $select y
// se agrega en JS. Sin esto el modelo respondía el histórico completo como si
// fuera el subconjunto (595 M "de julio" cuando julio eran 46 M).
const PAGINA_FILTRADO = 100;
const MAX_FILAS_FILTRADO = 20_000;
export const GRUPO_MES = "mes";
/**
 * Entidades de documento en las que una fila cancelada NO es facturación real.
 * SAP deja `DocumentStatus` en "bost_Close" al cancelar, así que sin mirar
 * `Cancelled` una cancelada parece una cerrada normal y su importe se suma.
 */
const DOCS_CANCELABLES = new Set([
  "invoices",
  "purchaseinvoices",
  "orders",
  "purchaseorders",
  "deliverynotes",
  "purchasedeliverynotes",
  "creditnotes",
  "quotations",
]);
/**
 * Agrupar por año (AAAA) de DocDate. Sin esto, "qué año se facturó más"
 * obligaba al modelo a agrupar por mes y sumarlos a mano: comparaba el MES más
 * alto de cada año en vez del total anual y respondía el año equivocado. En
 * SAP el error es doble, porque las 1,590 facturas de 2025 están cargadas en
 * bloque con DocDate 2025-12-31: ese "diciembre" gana cualquier comparación
 * mes a mes aunque 2026 facture casi el triple en el año.
 */
export const GRUPO_ANIO = "año";

async function agregarFiltrado(
  entidad: string,
  filtro: string,
  grupos: string[],
  metricas: Array<{ campo: string; operacion: OperacionAgregado }>,
  aliasDe: (m: { campo: string; operacion: OperacionAgregado }) => string
): Promise<{
  filas: Record<string, unknown>[];
  considerados: number;
  total: number | null;
  truncado: boolean;
  totalGeneral: Record<string, number>;
}> {
  // Paginación por cursor de DocEntry (como la sincronización de facturas):
  // con $skip sin $orderby el Service Layer no garantiza páginas estables y
  // al superar el tope se cortaba un mes por la mitad (diciembre 2025 salía
  // con 1,289 de 1,590 facturas). Cada página es una consulta indexada nueva.
  const camposSelect = grupos.map((g) => (g === GRUPO_MES || g === GRUPO_ANIO ? "DocDate" : g));
  const select = [...new Set(["DocEntry", ...camposSelect, ...metricas.map((m) => m.campo)])].join(",");
  const acum = new Map<string, { clave: Record<string, unknown>; n: number; suma: Record<string, number>; max: Record<string, number>; min: Record<string, number> }>();
  let considerados = 0;
  let truncado = false;
  let total: number | null = null;
  let cursor = 0;
  for (;;) {
    const params = new URLSearchParams();
    params.set("$filter", `(${filtro}) and DocEntry gt ${cursor}`);
    params.set("$select", select);
    params.set("$orderby", "DocEntry asc");
    params.set("$top", String(PAGINA_FILTRADO));
    if (total === null) params.set("$inlinecount", "allpages");
    const data = await sapFetch<{ value?: Record<string, unknown>[]; "odata.count"?: string | number; "@odata.count"?: number }>(
      `/${entidad}?${params.toString()}`,
      { headers: { Prefer: `odata.maxpagesize=${PAGINA_FILTRADO}` } }
    );
    if (total === null) {
      const bruto = data["odata.count"] ?? data["@odata.count"];
      total = bruto === undefined ? null : Number(bruto);
    }
    const pagina = data.value ?? [];
    for (const f of pagina) {
      considerados++;
      const clave: Record<string, unknown> = Object.fromEntries(
        grupos.map((g) => {
          if (g !== GRUPO_MES && g !== GRUPO_ANIO) return [g, f[g] ?? null];
          // DocDate llega como texto ISO: el mes son sus 7 primeros caracteres
          // y el año los 4 primeros.
          const fecha = String(f.DocDate ?? "");
          return [g, fecha.slice(0, g === GRUPO_MES ? 7 : 4) || null];
        })
      );
      const k = JSON.stringify(clave);
      const g = acum.get(k) ?? { clave, n: 0, suma: {}, max: {}, min: {} };
      g.n++;
      for (const m of metricas) {
        const v = Number(f[m.campo]);
        if (!Number.isFinite(v)) continue;
        g.suma[m.campo] = (g.suma[m.campo] ?? 0) + v;
        g.max[m.campo] = Math.max(g.max[m.campo] ?? -Infinity, v);
        g.min[m.campo] = Math.min(g.min[m.campo] ?? Infinity, v);
      }
      acum.set(k, g);
    }
    if (pagina.length < PAGINA_FILTRADO) break;
    cursor = Number(pagina[pagina.length - 1].DocEntry);
    if (!Number.isFinite(cursor)) break;
    if (considerados >= MAX_FILAS_FILTRADO) {
      truncado = true;
      break;
    }
  }
  const filas = [...acum.values()].map((g) => {
    const fila: Record<string, unknown> = { ...g.clave };
    for (const m of metricas) {
      const valor =
        m.operacion === "suma" ? g.suma[m.campo] :
        m.operacion === "promedio" ? (g.n ? g.suma[m.campo] / g.n : undefined) :
        m.operacion === "max" ? g.max[m.campo] : g.min[m.campo];
      fila[aliasDe(m)] = valor === undefined || !Number.isFinite(valor) ? null : Math.round(valor * 100) / 100;
    }
    fila.documentos = g.n;
    return fila;
  });

  // Total sobre TODOS los grupos, no sólo los que se devuelven. Sin esto, al
  // pedir "el top 5" el modelo tomaba la suma de esas 5 filas como si fuera el
  // total de la empresa y calculaba porcentajes sobre un denominador que no
  // existe (Costco salía al 70.7% del total cuando es el 61.5%).
  const totalGeneral: Record<string, number> = {};
  for (const m of metricas) {
    const alias = aliasDe(m);
    let acumulado = 0;
    for (const g of acum.values()) {
      const v =
        m.operacion === "suma" ? g.suma[m.campo] :
        m.operacion === "promedio" ? (g.n ? g.suma[m.campo] / g.n : undefined) :
        m.operacion === "max" ? g.max[m.campo] : g.min[m.campo];
      if (v !== undefined && Number.isFinite(v)) acumulado += v;
    }
    totalGeneral[alias] = Math.round(acumulado * 100) / 100;
  }
  totalGeneral.documentos = considerados;

  return { filas, considerados, total, truncado, totalGeneral };
}

/**
 * Suma de las filas DEVUELTAS y su peso sobre el total, cuando la respuesta va
 * recortada a un top N. Sin esto el modelo sumaba el top 5 de cabeza para decir
 * que "concentran el 85.9%" cuando es el 86.09%: la regla de no calcular a mano
 * no sirve de nada si la cifra que hace falta no existe en ningún resultado.
 */
function sumarClaves(filas: Record<string, unknown>[], claves: string[]): Record<string, number> {
  const suma: Record<string, number> = {};
  for (const clave of claves) {
    let t = 0;
    for (const fila of filas) t += Number(fila[clave]) || 0;
    suma[clave] = Math.round(t * 100) / 100;
  }
  return suma;
}

function resumirDevueltas(
  devueltas: Record<string, unknown>[],
  claves: string[],
  totalGeneral: Record<string, unknown> | undefined
): Record<string, unknown> | null {
  if (!devueltas.length || !claves.length) return null;
  const suma = sumarClaves(devueltas, claves);
  const principal = claves[0];
  const base = Number(totalGeneral?.[principal]);
  const pct =
    Number.isFinite(base) && base !== 0
      ? Math.round((suma[principal] / base) * 10000) / 100
      : null;
  return {
    sumaDevueltas: suma,
    ...(pct !== null ? { participacionDevueltasPct: pct } : {}),
    notaDevueltas:
      "`sumaDevueltas` es la suma de las " +
      String(devueltas.length) +
      " filas devueltas y `participacionDevueltasPct` es su porcentaje sobre el total: " +
      "úsalos tal cual para decir cuánto concentran, en vez de sumarlas tú.",
  };
}

export async function agregarSap(consulta: AgregadoSap): Promise<ResultadoAgregadoSap> {
  const entidad = consulta.entidad.trim().replace(/^\/+/, "");
  if (!entidad || entidad.includes("..") || PROHIBIDAS.has(nombreEntidad(entidad))) {
    throw new Error(`Entidad no permitida: ${consulta.entidad}`);
  }
  // `mes` y `año` no son campos de OData sino agrupaciones que se calculan
  // aquí a partir de DocDate: la regex de campo las rechazaría ("año" ni
  // siquiera es ASCII) y se caerían en silencio, devolviendo UN total global
  // en vez de una fila por periodo.
  const grupos = (consulta.agruparPor ?? []).filter(
    (c) => c === GRUPO_MES || c === GRUPO_ANIO || CAMPO_ODATA.test(c)
  );
  const metricas = (consulta.metricas ?? []).filter((m) => CAMPO_ODATA.test(m.campo));
  let filtro = consulta.filtro?.trim();

  // Las canceladas se quedan FUERA salvo que se pidan explícitamente: sumarlas
  // infla la facturación (Coppel: 46,106.14 con ellas frente a 29,340.91 reales;
  // 94 documentos y 19.3 M en toda la base). Se avisa siempre, para que la
  // respuesta pueda decir de dónde sale la cifra.
  const cancelables = DOCS_CANCELABLES.has(nombreEntidad(entidad));
  const yaFiltraCanceladas = /\bCancelled\b/i.test(filtro ?? "");
  let excluidasCanceladas = false;
  if (cancelables && !yaFiltraCanceladas) {
    // `ne 'tYES'` y NO `eq 'tNO'`: 94 documentos válidos (las facturas de
    // reemplazo de la serie 1000xx) tienen Cancelled nulo, y `eq 'tNO'` los
    // dejaba fuera — 2026 caía de 435.8 M a 397.3 M, excluyendo 38 M reales.
    const sinCancelar = "Cancelled ne 'tYES'";
    filtro = filtro ? `(${filtro}) and ${sinCancelar}` : sinCancelar;
    excluidasCanceladas = true;
  }

  const porPeriodo = grupos.includes(GRUPO_MES) || grupos.includes(GRUPO_ANIO);
  if (porPeriodo && !filtro) {
    throw new Error(
      "Agrupar por mes o año requiere acotar el periodo en `filtro`, ej: \"DocDate ge '2025-01-01' and DocDate le '2026-12-31'\"."
    );
  }
  if (filtro) {
    const aliasDe = (m: { campo: string; operacion: OperacionAgregado }) => `${m.operacion}_${m.campo}`;
    const { filas, considerados, total, truncado, totalGeneral } = await agregarFiltrado(
      entidad, filtro, grupos, metricas, aliasDe
    );
    const claveOrden = metricas.length ? aliasDe(metricas[0]) : "documentos";
    const clavePeriodo = grupos.includes(GRUPO_MES) ? GRUPO_MES : GRUPO_ANIO;
    if (porPeriodo)
      filas.sort((a, b) => String(a[clavePeriodo]).localeCompare(String(b[clavePeriodo])));
    else filas.sort((a, b) => (Number(b[claveOrden]) || 0) - (Number(a[claveOrden]) || 0));
    const top = Math.min(Math.max(consulta.top ?? 20, 1), 100);
    const mostradas = filas.slice(0, top);
    const clavesNum = [...metricas.map(aliasDe), "documentos"];
    const resumen =
      grupos.length && filas.length > mostradas.length
        ? resumirDevueltas(mostradas, clavesNum, totalGeneral)
        : null;
    return {
      grupos: filas.length,
      devueltas: mostradas.length,
      filas: mostradas,
      filtro,
      ...(resumen ?? {}),
      ...(grupos.length && totalGeneral
        ? {
            totalGeneral,
            notaTotalGeneral:
              "`totalGeneral` es la suma sobre TODOS los grupos del filtro, no sólo sobre las filas " +
              "devueltas: úsalo como denominador para porcentajes y como total, en vez de sumar las filas.",
          }
        : {}),
      ...(excluidasCanceladas
        ? {
            notaCanceladas:
              "Las facturas/documentos CANCELADOS quedan fuera de este total (se filtró Cancelled eq 'tNO'): " +
              "sumarlos daría facturación que no existió. Si el usuario quiere incluirlos, pásalo tú en `filtro`. " +
              "Menciona que la cifra excluye cancelados sólo si es relevante para lo que preguntaron.",
          }
        : {}),
      documentosConsiderados: considerados,
      ...(total !== null ? { documentosEnSap: total } : {}),
      ...(truncado
        ? {
            truncado: true,
            nota:
              `RESULTADO PARCIAL: solo se leyeron ${considerados} de ${total ?? "?"} documentos y los grupos ` +
              "están incompletos. NO lo presentes como total: acota el periodo (p. ej. un mes) y vuelve a consultar.",
          }
        : {}),
    };
  }

  // $count siempre: "cuántos documentos" es la pregunta más común.
  const aliasDe = (m: { campo: string; operacion: OperacionAgregado }) =>
    `${m.operacion}_${m.campo}`;
  const partes = [
    ...metricas.map((m) => `${m.campo} with ${OPERACION_ODATA[m.operacion]} as ${aliasDe(m)}`),
    "$count as documentos",
  ];
  const aggregate = `aggregate(${partes.join(",")})`;
  const apply = grupos.length ? `groupby((${grupos.join(",")}),${aggregate})` : aggregate;

  const data = await sapFetchV2<{ value?: Record<string, unknown>[] }>(
    `/${entidad}?$apply=${encodeURIComponent(apply)}&$top=${TOP_GRUPOS}`,
    { headers: { Prefer: `odata.maxpagesize=${TOP_GRUPOS}` } }
  );

  const filas = (data.value ?? []).map((f) => {
    const limpia = { ...f };
    delete limpia["@odata.id"];
    return limpia;
  });

  // SAP no sabe ordenar por el agregado: se ordena aquí, por la primera
  // métrica pedida (o por el conteo), de mayor a menor.
  const claveOrden = metricas.length ? aliasDe(metricas[0]) : "documentos";
  filas.sort((a, b) => (Number(b[claveOrden]) || 0) - (Number(a[claveOrden]) || 0));

  const top = Math.min(Math.max(consulta.top ?? 20, 1), 100);
  const mostradas = filas.slice(0, top);
  const clavesNum = [...metricas.map(aliasDe), "documentos"];
  // Aquí `filas` son TODOS los grupos, así que el total global se puede sumar
  // en el servidor antes de recortar: es el denominador de cualquier
  // porcentaje y, sin él, el modelo lo estimaba.
  const totalGeneral = grupos.length ? sumarClaves(filas, clavesNum) : undefined;
  const resumen =
    grupos.length && filas.length > mostradas.length
      ? resumirDevueltas(mostradas, clavesNum, totalGeneral)
      : null;
  return {
    grupos: filas.length,
    devueltas: mostradas.length,
    filas: mostradas,
    ...(totalGeneral
      ? {
          totalGeneral,
          notaTotalGeneral:
            "`totalGeneral` es la suma sobre TODOS los grupos, no sólo sobre las filas devueltas: " +
            "úsalo como denominador para porcentajes y como total, en vez de sumar las filas.",
        }
      : {}),
    ...(resumen ?? {}),
      ...(excluidasCanceladas
        ? {
            notaCanceladas:
              "Las facturas/documentos CANCELADOS quedan fuera de este total (se filtró Cancelled eq 'tNO'): " +
              "sumarlos daría facturación que no existió. Si el usuario quiere incluirlos, pásalo tú en `filtro`. " +
              "Menciona que la cifra excluye cancelados sólo si es relevante para lo que preguntaron.",
          }
        : {}),
  };
}

// ---------------------------------------------------------------------------
// Búsqueda de socios de negocio por nombre
// ---------------------------------------------------------------------------
//
// El $filter del Service Layer distingue mayúsculas y NO soporta toupper() ni
// tolower() ("invalid function parameter"), así que buscar un socio por nombre
// era una lotería que daba respuestas contradictorias sobre los MISMOS datos:
//
//   contains(CardName,'Liverpool') -> P0070  Distribuidora Liverpool  PROVEEDOR
//   contains(CardName,'LIVERPOOL') -> C000084 DISTRIBUIDORA LIVERPOOL CLIENTE
//   contains(CardName,'liverpool') -> nada
//   contains(CardName,'Coppel')    -> nada     (el socio se llama 'COPPEL')
//
// Con eso, "¿Liverpool es cliente o proveedor?" se contestaba según cómo se
// hubieran escrito las mayúsculas, y "¿le surtimos a Coppel?" que no existía.
// Peor: Liverpool es AMBAS cosas y ninguna de las dos búsquedas lo dice.
//
// Tampoco basta con ignorar mayúsculas: el mayor cliente está dado de alta como
// "NUEVA WAL MART DE MEXICO", así que buscar "walmart" —lo que escribe
// cualquiera— seguía dando cero. Por eso se compara también sin espacios y
// tolerando erratas.
//
// Como el catálogo es pequeño (cientos de socios), se trae entero y se filtra
// aquí. Devuelve SIEMPRE todas las coincidencias, de los dos tipos.

const SOCIOS_CAMPOS = "CardCode,CardName,CardType,CurrentAccountBalance,Currency,Valid,Phone1,EmailAddress";
const SOCIOS_PAGINA = 100;
/** Tope de seguridad por si el catálogo creciera: no vaciamos SAP en un chat. */
const SOCIOS_MAX = 3000;
const SOCIOS_TTL_MS = 5 * 60_000;

let cacheSocios: { filas: Record<string, unknown>[]; expira: number } | null = null;

/** Sin acentos, en mayúsculas, sin puntuación y con los espacios colapsados. */
function normalizarNombre(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Lo mismo pero sin espacios: "walmart" tiene que encontrar "WAL MART". */
function compactar(texto: string): string {
  return normalizarNombre(texto).replace(/ /g, "");
}

/** Distancia de edición, para tolerar erratas ("copel" -> "COPPEL"). */
function distancia(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (!m || !n) return m || n;
  let previa = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const actual = [i];
    for (let j = 1; j <= n; j++) {
      const coste = a[i - 1] === b[j - 1] ? 0 : 1;
      actual[j] = Math.min(previa[j] + 1, actual[j - 1] + 1, previa[j - 1] + coste);
    }
    previa = actual;
  }
  return previa[n];
}

/** Dos palabras son "la misma" si difieren en poco respecto a su longitud. */
function pareceLoMismo(a: string, b: string): boolean {
  if (a === b) return true;
  const corta = Math.min(a.length, b.length);
  if (corta < 4) return false;
  return distancia(a, b) <= (corta >= 8 ? 2 : 1);
}

/**
 * Distancia de `aguja` al TROZO más parecido de `texto` (inicio y fin libres).
 * Con esto "wallmart" encuentra "NUEVAWALMARTDEMEXICO": la errata está dentro
 * de un nombre mucho más largo y comparar los dos enteros no la ve.
 */
function distanciaEnSubcadena(aguja: string, texto: string): number {
  const m = aguja.length;
  const n = texto.length;
  if (!m) return 0;
  if (!n) return m;
  let previa = new Array<number>(n + 1).fill(0); // fila 0 a cero: el inicio es libre
  for (let i = 1; i <= m; i++) {
    const actual = [i];
    for (let j = 1; j <= n; j++) {
      const coste = aguja[i - 1] === texto[j - 1] ? 0 : 1;
      actual[j] = Math.min(previa[j] + 1, actual[j - 1] + 1, previa[j - 1] + coste);
    }
    previa = actual;
  }
  return Math.min(...previa); // el final también es libre
}

/**
 * Una coincidencia con errata sólo es FIRME si además de parecerse EXPLICA el
 * nombre: o la aguja cubre casi todo ("COPEL" sobre "COPPEL"), o es larga de
 * por sí ("WALLMART", "LIVERPUL"). Sin esta condición "bayer" casaba con
 * "Logistica Industrial BACER" —una letra— y se respondía como si fuera él.
 */
function coincidenciaAproximadaFirme(aguja: string, nombre: string): boolean {
  const tolerancia = aguja.length >= 9 ? 2 : 1;
  if (distanciaEnSubcadena(aguja, nombre) > tolerancia) return false;
  return aguja.length / Math.max(nombre.length, 1) >= 0.6 || aguja.length >= 7;
}

/**
 * Cuánto se parece la búsqueda a un socio. 0 = nada. Por encima de
 * COINCIDENCIA_FIRME es una coincidencia de verdad; por debajo es sólo un
 * parecido que hay que OFRECER, nunca descartar en silencio: ahí es donde se
 * colaba el "no existe" sobre clientes reales.
 */
const COINCIDENCIA_FIRME = 60;

function puntuar(aguja: string, nombre: string, codigo: string): number {
  const ac = compactar(aguja);
  const nc = compactar(nombre);
  if (!ac) return 0;
  if (compactar(codigo) === ac) return 100;
  if (nc.includes(ac)) return 95; // "walmart" dentro de "NUEVAWALMARTDEMEXICO"
  if (ac.includes(nc) && nc.length >= 4) return 85;

  const palabrasAguja = normalizarNombre(aguja).split(" ").filter((w) => w.length >= 3);
  const palabrasNombre = normalizarNombre(nombre).split(" ").filter(Boolean);
  if (palabrasAguja.length > 1) {
    // Varias palabras: que estén TODAS (admitiendo plural o errata) ya es firme,
    // porque acertar dos por casualidad no pasa.
    const encajan = palabrasAguja.filter((w) => palabrasNombre.some((v) => pareceLoMismo(w, v)));
    if (encajan.length === palabrasAguja.length) return 75;
    if (encajan.length) return 40;
  }
  if (coincidenciaAproximadaFirme(ac, nc)) return 70;
  // Se parece, pero poco: sugerencia, nunca respuesta.
  if (distanciaEnSubcadena(ac, nc) <= (ac.length >= 6 ? 2 : 1)) return 40;
  for (const v of palabrasNombre) if (v.length >= 4 && pareceLoMismo(ac, v)) return 40;
  return 0;
}

async function todosLosSocios(): Promise<Record<string, unknown>[]> {
  if (cacheSocios && cacheSocios.expira > Date.now()) return cacheSocios.filas;
  const filas: Record<string, unknown>[] = [];
  for (let saltar = 0; saltar < SOCIOS_MAX; saltar += SOCIOS_PAGINA) {
    const params = new URLSearchParams({
      $select: SOCIOS_CAMPOS,
      $top: String(SOCIOS_PAGINA),
      $skip: String(saltar),
      $orderby: "CardCode",
    });
    const data = await sapFetch<{ value?: Record<string, unknown>[] }>(
      `/BusinessPartners?${params.toString()}`,
      { headers: { Prefer: `odata.maxpagesize=${SOCIOS_PAGINA}` } }
    );
    const pagina = data.value ?? [];
    filas.push(...pagina);
    if (pagina.length < SOCIOS_PAGINA) break;
  }
  cacheSocios = { filas, expira: Date.now() + SOCIOS_TTL_MS };
  return filas;
}

export interface ResultadoBusquedaSocios {
  buscado: string;
  encontrados: number;
  socios: Array<Record<string, unknown>>;
  clientes: number;
  proveedores: number;
  /** Parecidos que NO son coincidencia firme: hay que ofrecerlos, no ignorarlos. */
  parecidos?: Array<Record<string, unknown>>;
  /** Explica el resultado en los términos que el modelo debe repetir. */
  nota: string;
}

export async function buscarSocios(texto: string): Promise<ResultadoBusquedaSocios> {
  const aguja = String(texto ?? "").trim();
  if (!normalizarNombre(aguja)) throw new Error("Falta el nombre o código a buscar.");
  const todos = await todosLosSocios();

  const etiquetar = (f: Record<string, unknown>, puntos: number): Record<string, unknown> => ({
    ...f,
    tipo:
      f.CardType === "cSupplier"
        ? "proveedor"
        : f.CardType === "cCustomer"
          ? "cliente"
          : String(f.CardType ?? ""),
    parecido: puntos,
  });

  const puntuados = todos
    .map((f) => ({ f, puntos: puntuar(aguja, String(f.CardName ?? ""), String(f.CardCode ?? "")) }))
    .filter((x) => x.puntos > 0)
    .sort((a, b) => b.puntos - a.puntos);

  const firmes = puntuados.filter((x) => x.puntos >= COINCIDENCIA_FIRME);
  const flojos = puntuados.filter((x) => x.puntos < COINCIDENCIA_FIRME).slice(0, 8);

  const socios = firmes.map((x) => etiquetar(x.f, x.puntos));
  const parecidos = flojos.map((x) => etiquetar(x.f, x.puntos));
  const clientes = firmes.filter((x) => x.f.CardType === "cCustomer").length;
  const proveedores = firmes.filter((x) => x.f.CardType === "cSupplier").length;

  let nota: string;
  if (!socios.length && parecidos.length) {
    // NUNCA presentar esto como "no existe": es lo que hacía que se negara un
    // cliente real por una errata o un espacio de más en el nombre.
    nota =
      `No hay coincidencia exacta con "${texto}", pero SÍ hay socios parecidos (mira "parecidos"). ` +
      "NO respondas que no existe: enséñalos y pregunta al usuario a cuál se refiere.";
  } else if (!socios.length) {
    nota =
      `Ningún socio de negocio se parece a "${texto}". Se revisó el catálogo COMPLETO ` +
      `(${todos.length} socios) ignorando mayúsculas, acentos, espacios y erratas, así que esto sí es ` +
      "una ausencia real. Aun así, si el nombre pudiera estar dado de alta por su razón social en vez " +
      "de por su nombre comercial, prueba esa variante antes de cerrar el tema.";
  } else if (clientes && proveedores) {
    nota =
      `Ojo: "${texto}" está dado de alta DOS veces, como cliente y como proveedor, con códigos ` +
      "distintos. Son registros separados: las facturas de venta cuelgan del cliente y las de compra " +
      "del proveedor. Dilo así en vez de elegir uno.";
  } else {
    nota =
      `Se revisó el catálogo completo (${todos.length} socios) ignorando mayúsculas, acentos, espacios ` +
      "y erratas. Si el nombre encontrado difiere del que escribió el usuario (razón social frente a " +
      "nombre comercial), dilo al responder.";
  }

  return {
    buscado: texto,
    encontrados: socios.length,
    socios,
    clientes,
    proveedores,
    ...(parecidos.length ? { parecidos } : {}),
    nota,
  };
}
