import { Invoice, Supplier } from "@/models/proveedores";

const ESTADOS_PENDIENTES = ["EN_REVISION", "NC_EN_REVISION"];
const ESTADOS_POR_PAGAR = ["APROBADA_PAGO", "REGISTRADA_SAP", "CUENTAS_POR_PAGAR"];
const HORA_MS = 3_600_000;
const DIA_MS = 86_400_000;

export interface FacturaReporte {
  folio: string;
  proveedor: string;
  codigoProveedor: string;
  importe: string;
  moneda: string;
  estatus: string;
  recibidaEl: string | null;
  liberadaEl: string | null;
  vencimiento: string | null;
  horasSinLiberar: number | null;
  diasAlVencimiento: number | null;
}

async function conNombres(facturas: Array<Record<string, unknown>>): Promise<FacturaReporte[]> {
  const codigos = [...new Set(facturas.map((f) => String(f.supplierCode ?? "")))];
  const proveedores = await Supplier()
    .find({ supplierCode: { $in: codigos } }, { supplierCode: 1, legalName: 1 })
    .lean();
  const nombres = new Map(proveedores.map((p) => [String(p.supplierCode), p.legalName]));
  const ahora = Date.now();

  return facturas.map((f) => {
    const recibida = (f.submittedAt ?? f.createdAt) as Date | null;
    const liberada = (f.paymentApprovedAt ?? f.creditStartsAt) as Date | null;
    const vence = (f.creditDueAt ?? f.sapDocDueDate) as Date | null;
    return {
      folio: String(f.folio),
      proveedor: nombres.get(String(f.supplierCode)) ?? String(f.supplierCode),
      codigoProveedor: String(f.supplierCode),
      importe: String(f.total ?? "0.00"),
      moneda: String(f.currency ?? "MXN"),
      estatus: String(f.status),
      recibidaEl: recibida?.toISOString() ?? null,
      liberadaEl: liberada?.toISOString() ?? null,
      vencimiento: vence?.toISOString() ?? null,
      horasSinLiberar: recibida ? Math.floor((ahora - recibida.getTime()) / HORA_MS) : null,
      diasAlVencimiento: vence ? Math.ceil((vence.getTime() - ahora) / DIA_MS) : null,
    };
  });
}

export async function reporteFacturasProveedores(tipo: "pendientes" | "por-vencer" | "vencidas") {
  if (tipo === "pendientes") {
    const facturas = await Invoice()
      .find({ archivedAt: { $in: [null] }, status: { $in: ESTADOS_PENDIENTES } })
      .sort({ submittedAt: 1, createdAt: 1 })
      .limit(500)
      .lean();
    return conNombres(facturas as unknown as Array<Record<string, unknown>>);
  }

  const ahora = new Date();
  const enSieteDias = new Date(ahora.getTime() + 7 * DIA_MS);
  const campoFecha = { $ifNull: ["$creditDueAt", "$sapDocDueDate"] };
  const comparacion = tipo === "vencidas"
    ? { $lt: [campoFecha, ahora] }
    : { $gte: [campoFecha, ahora] };
  // `$expr` permite usar creditDueAt y caer al vencimiento legado de SAP sin
  // duplicar documentos en un `$or` difícil de mantener.
  const tieneFecha = { $ne: [campoFecha, null] };
  const filtroFecha = tipo === "vencidas"
    ? { $expr: { $and: [tieneFecha, comparacion] } }
    : { $expr: { $and: [tieneFecha, comparacion, { $lte: [campoFecha, enSieteDias] }] } };
  const facturas = await Invoice()
    .find({ status: { $in: ESTADOS_POR_PAGAR }, ...filtroFecha })
    .sort({ creditDueAt: 1, sapDocDueDate: 1 })
    .limit(500)
    .lean();
  return conNombres(facturas as unknown as Array<Record<string, unknown>>);
}
