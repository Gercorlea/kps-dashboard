// Capa de consultas de SOLO LECTURA sobre el Service Layer, pensada para
// exponerse como herramienta a KPS AI. Reglas:
//  - GET por construcción: jamás se pasa method/body a sapFetch.
//  - Cualquier entity set del Service Layer (son ~332), salvo Login/Logout.
//  - $top acotado y $select por defecto para no reventar tokens.
import { camposPorDefecto, nombreEntidad } from "./campos";
import { sapFetch } from "./service-layer";

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

  const filas = data.value ?? [];
  const bruto = data["odata.count"] ?? data["@odata.count"];
  const total = bruto === undefined ? null : Number(bruto);
  return {
    total: Number.isFinite(total) ? total : null,
    devueltas: filas.length,
    filas,
    ...(porDefecto ? { campos: porDefecto } : {}),
  };
}
