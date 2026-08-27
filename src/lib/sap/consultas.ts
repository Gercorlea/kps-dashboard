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
  const filas = enriquecerFrescura(data.value ?? []);
  const bruto = data["odata.count"] ?? data["@odata.count"];
  const total = bruto === undefined ? null : Number(bruto);
  return {
    total: Number.isFinite(total) ? total : null,
    devueltas: filas.length,
    filas,
    ...(porDefecto ? { campos: porDefecto } : {}),
  };
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
  agruparPor?: string[]; // campos de agrupación; sin ellos, un total global
  metricas?: Array<{ campo: string; operacion: OperacionAgregado }>;
  top?: number; // grupos a devolver tras ordenar (defecto 20)
}

export interface ResultadoAgregadoSap {
  grupos: number; // cuántos grupos existen en total
  devueltas: number;
  filas: Record<string, unknown>[];
}

const CAMPO_ODATA = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TOP_GRUPOS = 1000; // tope de grupos que se traen para ordenar en JS

export async function agregarSap(consulta: AgregadoSap): Promise<ResultadoAgregadoSap> {
  const entidad = consulta.entidad.trim().replace(/^\/+/, "");
  if (!entidad || entidad.includes("..") || PROHIBIDAS.has(nombreEntidad(entidad))) {
    throw new Error(`Entidad no permitida: ${consulta.entidad}`);
  }
  const grupos = (consulta.agruparPor ?? []).filter((c) => CAMPO_ODATA.test(c));
  const metricas = (consulta.metricas ?? []).filter((m) => CAMPO_ODATA.test(m.campo));

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
