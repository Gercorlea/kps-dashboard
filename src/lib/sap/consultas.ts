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
  const select = consulta.campos?.length ? consulta.campos.join(",") : porDefecto;

  const params = new URLSearchParams();
  if (consulta.filtro) params.set("$filter", consulta.filtro);
  if (select) params.set("$select", select);
  if (consulta.ordenarPor) params.set("$orderby", consulta.ordenarPor);
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
  return {
    total: Number.isFinite(total) ? total : null,
    devueltas: filas.length,
    filas,
    ...(porDefecto ? { campos: porDefecto } : {}),
    ...(resumenLineas ? { resumenLineas } : {}),
  };
}

// Sumas de las colecciones anidadas calculadas AQUÍ, sobre todas las líneas
// devueltas (antes del recorte a LINEAS_MAX) y por moneda del documento. El
// modelo sumaba 114 líneas a mano y se equivocaba (724,618 piezas en vez de
// 907,952): con esto reporta las cifras del servidor.
const CAMPOS_SUMABLES_LINEA = ["Quantity", "RemainingOpenQuantity", "OpenAmount", "LineTotal"] as const;

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

async function agregarFiltrado(
  entidad: string,
  filtro: string,
  grupos: string[],
  metricas: Array<{ campo: string; operacion: OperacionAgregado }>,
  aliasDe: (m: { campo: string; operacion: OperacionAgregado }) => string
): Promise<{ filas: Record<string, unknown>[]; considerados: number; total: number | null; truncado: boolean }> {
  // Paginación por cursor de DocEntry (como la sincronización de facturas):
  // con $skip sin $orderby el Service Layer no garantiza páginas estables y
  // al superar el tope se cortaba un mes por la mitad (diciembre 2025 salía
  // con 1,289 de 1,590 facturas). Cada página es una consulta indexada nueva.
  const camposSelect = grupos.map((g) => (g === GRUPO_MES ? "DocDate" : g));
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
        grupos.map((g) => [g, g === GRUPO_MES ? String(f.DocDate ?? "").slice(0, 7) || null : (f[g] ?? null)])
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
  return { filas, considerados, total, truncado };
}

export async function agregarSap(consulta: AgregadoSap): Promise<ResultadoAgregadoSap> {
  const entidad = consulta.entidad.trim().replace(/^\/+/, "");
  if (!entidad || entidad.includes("..") || PROHIBIDAS.has(nombreEntidad(entidad))) {
    throw new Error(`Entidad no permitida: ${consulta.entidad}`);
  }
  const grupos = (consulta.agruparPor ?? []).filter((c) => CAMPO_ODATA.test(c));
  const metricas = (consulta.metricas ?? []).filter((m) => CAMPO_ODATA.test(m.campo));
  const filtro = consulta.filtro?.trim();
  const porMes = grupos.includes(GRUPO_MES);
  if (porMes && !filtro) {
    throw new Error(
      "Agrupar por mes requiere acotar el periodo en `filtro`, ej: \"DocDate ge '2025-01-01' and DocDate le '2025-12-31'\"."
    );
  }
  if (filtro) {
    const aliasDe = (m: { campo: string; operacion: OperacionAgregado }) => `${m.operacion}_${m.campo}`;
    const { filas, considerados, total, truncado } = await agregarFiltrado(entidad, filtro, grupos, metricas, aliasDe);
    const claveOrden = metricas.length ? aliasDe(metricas[0]) : "documentos";
    if (porMes) filas.sort((a, b) => String(a[GRUPO_MES]).localeCompare(String(b[GRUPO_MES])));
    else filas.sort((a, b) => (Number(b[claveOrden]) || 0) - (Number(a[claveOrden]) || 0));
    const top = Math.min(Math.max(consulta.top ?? 20, 1), 100);
    return {
      grupos: filas.length,
      devueltas: Math.min(filas.length, top),
      filas: filas.slice(0, top),
      filtro,
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
  return { grupos: filas.length, devueltas: Math.min(filas.length, top), filas: filas.slice(0, top) };
}
