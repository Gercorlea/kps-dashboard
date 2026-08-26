import { sapFetch } from "@/lib/sap/service-layer";
import { AuditLog, Invoice } from "@/models/proveedores";

/**
 * Paga una factura en Business One. SOLO PARA PRUEBAS.
 *
 * ESTO NO ES TESORERIA Y NO DEBE SERLO. En la operacion real el pago lo hace
 * tesoreria dentro de B1, y hay razones de peso para que siga siendo asi:
 *
 *   - SEGREGACION DE FUNCIONES (§02). Quien aprueba una factura no puede
 *     pagarla. Si el mismo dashboard hace las dos cosas, un solo usuario aprueba
 *     y paga sin que nadie lo vea.
 *   - LOS CONTROLES VIVEN EN SAP. Autorizaciones de pago, limites por cuenta,
 *     conciliacion bancaria. Un boton se los salta todos.
 *   - UN PAGO NO ES UN BOTON. Es elegir cuenta, moneda, forma de pago, si es
 *     total o parcial, la fecha valor. Aqui se decide todo por omision, que es
 *     justo lo que no se puede hacer con dinero de verdad.
 *
 * ENTONCES POR QUE EXISTE. Porque sin esto no se puede probar el tramo final del
 * portal —detectar el pago, calcular el plazo del complemento, cerrarlo— sin
 * depender de que alguien con acceso a Business One pague a mano. Es el mismo
 * caso que la captura de entradas del portal, y lleva el mismo tratamiento:
 * apagado por omision y una bandera explicita para encenderlo.
 *
 * `FEATURE_PAGO_SIMULADO=true` lo habilita. NUNCA en produccion.
 */

/** Sin esto, la ruta responde 403 aunque alguien la descubra. */
export function pagoSimuladoHabilitado(): boolean {
  return process.env.FEATURE_PAGO_SIMULADO === "true";
}

export type MotivoNoPago =
  | "DESHABILITADO"
  | "NO_REGISTRADA"
  | "YA_PAGADA"
  | "SIN_CUENTA"
  | "SAP";

export class PagoSimuladoError extends Error {
  constructor(
    readonly motivo: MotivoNoPago,
    message: string
  ) {
    super(message);
    this.name = "PagoSimuladoError";
  }
}

interface FacturaB1 {
  DocEntry: number;
  DocNum: number;
  CardCode: string;
  DocCurrency?: string | null;
  DocRate?: number | null;
  DocTotal?: number | null;
  DocTotalFc?: number | null;
  PaidToDate?: number | null;
  DocumentStatus?: string | null;
}

interface CuentaB1 {
  Code: string;
  FormatCode?: string | null;
  Name?: string | null;
  AcctCurrency?: string | null;
}

/** Hoy en 'AAAA-MM-DD'. B1 espera la fecha sin hora ni zona. */
function hoy(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Una cuenta de banco que admita esta moneda.
 *
 * B1 rechaza el pago si la moneda del documento no coincide con la de la cuenta
 * —"Account currency ... not the same as document currency"—, y tambien si no
 * coincide con la del proveedor. Asi que la moneda la manda la FACTURA y aqui
 * solo se busca una cuenta compatible: la de esa moneda, o una multimoneda
 * (`##`), que acepta cualquiera.
 */
async function cuentaPara(moneda: string): Promise<CuentaB1> {
  const cuentas: CuentaB1[] = [];
  for (let skip = 0; ; skip += 200) {
    const body = await sapFetch<{ value?: CuentaB1[] }>(
      `/ChartOfAccounts?$select=Code,FormatCode,Name,AcctCurrency&$top=200&$skip=${skip}`
    );
    const v = body.value ?? [];
    cuentas.push(...v);
    if (v.length < 200 || cuentas.length >= 2000) break;
  }

  // Solo cuentas de banco: el grupo 102 del catalogo de KPS. Pagar desde
  // cualquier cuenta que "acepte la moneda" meteria el pago en una cuenta de
  // gasto o de cliente.
  const bancos = cuentas.filter((c) => String(c.FormatCode ?? "").startsWith("102"));
  const exacta = bancos.find((c) => c.AcctCurrency === moneda);
  const multi = bancos.find((c) => c.AcctCurrency === "##");
  const cuenta = exacta ?? multi;

  if (!cuenta) {
    throw new PagoSimuladoError(
      "SIN_CUENTA",
      `No hay ninguna cuenta de banco en ${moneda} ni multimoneda en el catálogo. Business One no admite pagar desde una cuenta en otra divisa.`
    );
  }
  return cuenta;
}

export interface ResultadoPago {
  docNum: number;
  docEntry: number;
  moneda: string;
  importe: number;
  cuenta: string;
}

/**
 * Crea el pago de una factura ya registrada en Business One.
 *
 * Paga el TOTAL y en la moneda de la factura: un pago parcial o en otra divisa
 * son decisiones de tesoreria, y esto no lo es.
 */
export async function simularPago(datos: {
  folio: string;
  actorId: string;
  actorRole: string;
}): Promise<ResultadoPago> {
  if (!pagoSimuladoHabilitado()) {
    throw new PagoSimuladoError(
      "DESHABILITADO",
      "El pago simulado está apagado. Es una herramienta de pruebas: se enciende con FEATURE_PAGO_SIMULADO=true y nunca debe estarlo en producción."
    );
  }

  const f = await Invoice().findOne({ folio: datos.folio }).lean();
  const docEntry = (f as { sapDocEntry?: number | null } | null)?.sapDocEntry ?? null;
  if (!f || !docEntry) {
    throw new PagoSimuladoError(
      "NO_REGISTRADA",
      `${datos.folio} no está registrada en Business One, así que no hay factura que pagar.`
    );
  }

  let b1: FacturaB1;
  try {
    b1 = await sapFetch<FacturaB1>(
      `/PurchaseInvoices(${docEntry})?$select=DocEntry,DocNum,CardCode,DocCurrency,DocRate,DocTotal,DocTotalFc,PaidToDate,DocumentStatus`
    );
  } catch (e) {
    throw new PagoSimuladoError(
      "SAP",
      e instanceof Error ? e.message : "No se pudo leer la factura en Business One."
    );
  }

  const total = b1.DocTotal ?? 0;
  if ((b1.PaidToDate ?? 0) >= total && total > 0) {
    throw new PagoSimuladoError(
      "YA_PAGADA",
      `La factura ${b1.DocNum} ya está saldada en Business One.`
    );
  }

  // La moneda la manda la factura. En moneda extranjera el importe que se paga
  // es el de esa divisa (`DocTotalFc`), no el convertido a pesos: mandar el
  // convertido pagaria 18 veces de mas.
  const moneda = b1.DocCurrency ?? "MXP";
  const esExtranjera = moneda !== "MXP" && moneda !== "MXN";
  const importe = esExtranjera ? (b1.DocTotalFc ?? 0) : total;

  const cuenta = await cuentaPara(moneda);
  const fecha = hoy();

  let pago: { DocNum: number; DocEntry: number };
  try {
    pago = await sapFetch<{ DocNum: number; DocEntry: number }>("/VendorPayments", {
      method: "POST",
      body: JSON.stringify({
        DocType: "rSupplier",
        CardCode: b1.CardCode,
        DocDate: fecha,
        DocCurrency: moneda,
        ...(b1.DocRate ? { DocRate: b1.DocRate } : {}),
        TransferAccount: cuenta.Code,
        TransferSum: importe,
        TransferDate: fecha,
        JournalRemarks: `Pago simulado desde el portal · ${datos.folio}`,
        PaymentInvoices: [
          { DocEntry: b1.DocEntry, InvoiceType: "it_PurchaseInvoice", SumApplied: importe },
        ],
      }),
    });
  } catch (e) {
    throw new PagoSimuladoError(
      "SAP",
      e instanceof Error ? e.message : "Business One rechazó el pago y no dijo por qué."
    );
  }

  // Queda en la bitácora interna, no en la del proveedor: el pago simulado es un
  // acto de pruebas de KPS y no le concierne a él. Lo que sí verá es el cambio a
  // PAGADA, que escribe el sincronizador cuando lea este pago de vuelta.
  await AuditLog().create({
    entityType: "invoice",
    entityId: datos.folio,
    action: "PAGO_SIMULADO",
    actorId: datos.actorId,
    actorRole: datos.actorRole,
    before: null,
    after: {
      pagoDocNum: pago.DocNum,
      facturaDocNum: b1.DocNum,
      moneda,
      importe,
      cuenta: cuenta.FormatCode ?? cuenta.Code,
    },
    comment: "Pago creado desde el portal con FEATURE_PAGO_SIMULADO. Herramienta de pruebas.",
    createdAt: new Date(),
  });

  return {
    docNum: pago.DocNum,
    docEntry: pago.DocEntry,
    moneda,
    importe,
    cuenta: `${cuenta.FormatCode ?? cuenta.Code} ${cuenta.Name ?? ""}`.trim(),
  };
}
