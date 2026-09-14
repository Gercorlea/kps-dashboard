import { Invoice, Supplier } from "@/models/proveedores";

const LIBERADAS = ["REGISTRADA_SAP", "CUENTAS_POR_PAGAR"];

export interface FilaDispersion {
  folioPortal: string;
  facturaSap: number | null;
  codigoProveedor: string;
  proveedor: string;
  rfc: string;
  banco: string;
  cuenta: string;
  clabe: string;
  moneda: string;
  importe: string;
  liberadaEl: string;
  vencimiento: string;
  datosBancariosCompletos: boolean;
  estado: string;
}

function valor(obj: Record<string, unknown>, claves: string[]): string {
  for (const clave of claves) {
    const v = obj[clave];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return "";
}

/** Lee las variantes legadas que existen en el expediente compartido. */
function bancoDe(proveedor: Record<string, unknown>) {
  const anidado = ["banking", "bankAccount", "bankData", "datosBancarios"]
    .map((k) => proveedor[k])
    .find((v) => v && typeof v === "object" && !Array.isArray(v));
  const banco = (anidado ?? proveedor) as Record<string, unknown>;
  return {
    nombre: valor(banco, ["bank", "bankName", "banco", "nombreBanco"]),
    cuenta: valor(banco, ["account", "accountNumber", "cuenta", "numeroCuenta"]),
    clabe: valor(banco, ["clabe", "CLABE", "interbankAccount"]),
  };
}

export async function filasDispersion(incluirEnviadas = false): Promise<FilaDispersion[]> {
  const filtro: Record<string, unknown> = {
    status: { $in: LIBERADAS },
    ...(incluirEnviadas ? {} : { disbursementSentAt: { $in: [null] } }),
  };
  const facturas = await Invoice().find(filtro).sort({ creditDueAt: 1, reviewedAt: 1 }).lean();
  const codigos = [...new Set(facturas.map((f) => f.supplierCode))];
  const proveedores = await Supplier().find({ supplierCode: { $in: codigos } }).lean();
  const porCodigo = new Map(proveedores.map((p) => [String(p.supplierCode), p]));

  return facturas.filter((f) => !porCodigo.get(f.supplierCode)?.blocked).map((f) => {
    const proveedor = porCodigo.get(f.supplierCode);
    const datosBanco = bancoDe((proveedor ?? {}) as unknown as Record<string, unknown>);
    return {
      folioPortal: f.folio,
      facturaSap: f.sapDocNum ?? null,
      codigoProveedor: f.supplierCode,
      proveedor: proveedor?.legalName ?? f.supplierCode,
      rfc: proveedor?.taxId ?? f.issuerTaxId ?? "",
      banco: datosBanco.nombre,
      cuenta: datosBanco.cuenta,
      clabe: datosBanco.clabe,
      moneda: f.currency ?? "MXN",
      importe: String(f.total ?? "0.00"),
      liberadaEl: (f.paymentApprovedAt ?? f.creditStartsAt ?? f.reviewedAt ?? f.createdAt).toISOString(),
      vencimiento: (f.creditDueAt ?? f.sapDocDueDate)?.toISOString() ?? "",
      datosBancariosCompletos: Boolean(datosBanco.nombre && (datosBanco.clabe || datosBanco.cuenta)),
      estado: f.status,
    };
  });
}

export async function crearExcelDispersion(filas: FilaDispersion[]): Promise<Uint8Array> {
  const XLSX = await import("xlsx");
  const hoja = XLSX.utils.json_to_sheet(
    filas.map((f) => ({
      "Folio portal": f.folioPortal,
      "Factura SAP": f.facturaSap ?? "",
      "Código proveedor": f.codigoProveedor,
      Proveedor: f.proveedor,
      RFC: f.rfc,
      Banco: f.banco,
      Cuenta: f.cuenta,
      CLABE: f.clabe,
      Moneda: f.moneda,
      Importe: Number(f.importe),
      "Liberada el": f.liberadaEl.slice(0, 10),
      Vencimiento: f.vencimiento.slice(0, 10),
      Observación: f.datosBancariosCompletos ? "" : "FALTAN DATOS BANCARIOS",
    }))
  );
  hoja["!cols"] = [
    { wch: 18 }, { wch: 12 }, { wch: 18 }, { wch: 38 }, { wch: 15 },
    { wch: 20 }, { wch: 20 }, { wch: 20 }, { wch: 10 }, { wch: 14 },
    { wch: 14 }, { wch: 14 }, { wch: 28 },
  ];
  const libro = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(libro, hoja, "Dispersión");
  return XLSX.write(libro, { type: "buffer", bookType: "xlsx" }) as Uint8Array;
}
