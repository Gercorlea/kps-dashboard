import { sapFetch } from "@/lib/sap/service-layer";
import { AuditLog, Invoice, InvoiceEvent } from "@/models/proveedores";

/**
 * Averigua en Business One que facturas ya se pagaron y lo refleja en el portal.
 *
 * POR QUE EXISTE. El pago NO pasa por el portal: tesoreria lo hace dentro de B1,
 * en el modulo de bancos. Sin esto, el portal se queda diciendo "registrada"
 * para siempre y el proveedor no se entera de que ya cobro —ni de que le toca
 * subir su complemento de pago—. La alternativa era que alguien de KPS marcara
 * cada factura a mano, que es justo la clase de paso que se olvida.
 *
 * SOLO LEE DE SAP. Ninguna escritura: se consulta el estado de las facturas que
 * el portal registro y se actualiza el documento local. Es seguro repetirlo
 * tantas veces como haga falta.
 *
 * DE DONDE SALE LA FECHA DEL PAGO. La factura no la lleva: `PaidToDate` dice
 * CUANTO se pago, no CUANDO. La fecha vive en el pago (`VendorPayments`), y
 * hace falta de verdad porque el plazo del complemento se cuenta por el MES del
 * pago —quinto dia natural del mes siguiente, regla 2.7.1.32—. Usar la fecha en
 * que corrimos la sincronizacion daria un mes equivocado si se corre tarde.
 *
 * UNA FACTURA PAGADA QUEDA EN `bost_Close`, no en `bost_Paid`. Comprobado en la
 * base de KPS. Por eso el criterio de "pagada" es el importe —`PaidToDate`
 * contra `DocTotal`— y no el estatus: el estatus tambien se cierra por otros
 * motivos, y confundirlos marcaria como pagada una factura que no lo esta.
 */

/** Estados desde los que una factura puede pasar a pagada. */
const SINCRONIZABLES = ["REGISTRADA_SAP", "CUENTAS_POR_PAGAR"];

/** Tope de facturas por corrida. Evita que una base grande dispare mil consultas. */
const MAX_POR_CORRIDA = 200;

/**
 * Cuantos pagos recientes se leen para buscar la fecha.
 *
 * Se leen por proveedor y de los mas nuevos hacia atras: el enlace pago->factura
 * vive en la coleccion `PaymentInvoices` y este Service Layer no admite filtrar
 * por campos de una coleccion anidada, asi que el cruce se hace despues de leer.
 */
const MAX_PAGOS_POR_PROVEEDOR = 200;

interface FacturaB1 {
  DocEntry: number;
  DocNum: number;
  CardCode: string;
  DocTotal?: number | null;
  PaidToDate?: number | null;
  DocumentStatus?: string | null;
  DocDueDate?: string | null;
}

interface PagoB1 {
  DocEntry: number;
  DocNum: number;
  CardCode: string;
  /** Fecha del pago. Es la que cuenta para el plazo del complemento. */
  DocDate?: string | null;
  /**
   * `Cancelled`, con DOS eles. El Service Layer responde 400 si se pide
   * `Canceled`: los documentos de marketing usan una grafia y los pagos otra, y
   * equivocarse tumba la consulta entera, no solo ese campo.
   */
  Cancelled?: string | null;
  PaymentInvoices?: Array<{ DocEntry?: number | null; InvoiceType?: string | null; SumApplied?: number | null }>;
}

export interface ResumenSincronizacion {
  /** Facturas que se miraron. */
  revisadas: number;
  /** Pasaron a PAGADA en esta corrida. */
  pagadas: Array<{ folio: string; docNum: number; pagadaEl: string | null; limiteComplemento: string | null }>;
  /** Tienen un pago parcial: siguen abiertas. */
  parciales: Array<{ folio: string; docNum: number; total: number; pagado: number }>;
  /**
   * Se dan por pagadas pero no se hallo el pago que las salda, asi que no
   * consta la fecha. Importa: sin ella no se puede calcular hasta cuando puede
   * el proveedor emitir su complemento.
   */
  sinFecha: Array<{ folio: string; docNum: number }>;
  /** No se pudieron consultar. */
  errores: Array<{ folio: string; motivo: string }>;
}

/**
 * Hasta cuando puede el proveedor emitir su complemento de pago.
 *
 * Regla 2.7.1.32 de la RMF: a mas tardar el QUINTO DIA NATURAL del mes
 * siguiente a aquel en que se recibio el pago. Dias naturales, no habiles: no
 * se saltan fines de semana.
 *
 * Se calcula en UTC a proposito. La fecha del pago viene de B1 sin hora ni zona
 * ('2026-09-21'), y construir el Date con la zona del servidor podria correr el
 * dia —y con el, el mes— justo en los pagos de fin de mes, que son los que mas
 * cerca quedan del limite.
 */
export function limiteComplemento(fechaPago: string): string {
  const [y, m] = fechaPago.slice(0, 10).split("-").map(Number);
  // Mes 0-indexado: `m` ya apunta al mes SIGUIENTE al del pago.
  return new Date(Date.UTC(y, m, 5)).toISOString().slice(0, 10);
}

/** Lee de B1 las facturas indicadas, por DocEntry. */
async function leerFacturas(docEntries: readonly number[]): Promise<Map<number, FacturaB1>> {
  const mapa = new Map<number, FacturaB1>();
  if (docEntries.length === 0) return mapa;

  // En tandas: un $filter con doscientos `or` produce una URL que algunos
  // proxies recortan en silencio, y el sintoma seria "faltan facturas".
  const TANDA = 25;
  for (let i = 0; i < docEntries.length; i += TANDA) {
    const tanda = docEntries.slice(i, i + TANDA);
    const filtro = tanda.map((d) => `DocEntry eq ${d}`).join(" or ");
    const body = await sapFetch<{ value?: FacturaB1[] }>(
      `/PurchaseInvoices?$select=DocEntry,DocNum,CardCode,DocTotal,PaidToDate,DocumentStatus,DocDueDate&$filter=${encodeURIComponent(filtro)}&$top=${tanda.length}`
    );
    for (const f of body.value ?? []) mapa.set(f.DocEntry, f);
  }
  return mapa;
}

/**
 * La fecha del pago de cada factura, buscada entre los pagos del proveedor.
 *
 * Devuelve la fecha del pago MAS RECIENTE que toca esa factura: si se liquido en
 * varios, el plazo del complemento corre desde el ultimo, que es cuando quedo
 * saldada.
 */
async function leerFechasDePago(
  cardCodes: readonly string[],
  docEntries: ReadonlySet<number>
): Promise<{ fechas: Map<number, string>; fallos: string[] }> {
  const fechas = new Map<number, string>();
  const fallos: string[] = [];

  for (const cardCode of new Set(cardCodes)) {
    let pagos: PagoB1[] = [];
    try {
      const body = await sapFetch<{ value?: PagoB1[] }>(
        `/VendorPayments?$select=DocEntry,DocNum,CardCode,DocDate,Cancelled,PaymentInvoices&$filter=CardCode eq '${cardCode.replace(/'/g, "''")}'&$orderby=DocEntry desc&$top=${MAX_PAGOS_POR_PROVEEDOR}`
      );
      pagos = body.value ?? [];
    } catch (e) {
      // NO se traga el fallo. Un error de consulta y "este proveedor no tiene
      // pagos" son indistinguibles desde aqui, y confundirlos marcaria la
      // factura como pagada sin fecha —y el plazo del complemento se calcula por
      // el MES del pago, asi que sin fecha no hay plazo que dar—. Quien llame
      // tiene que poder distinguir "no habia" de "no se pudo saber".
      fallos.push(
        `${cardCode}: ${e instanceof Error ? e.message : "no se pudieron leer sus pagos"}`
      );
      continue;
    }

    for (const p of pagos) {
      if (p.Cancelled === "tYES") continue;
      const fecha = (p.DocDate ?? "").slice(0, 10);
      if (!fecha) continue;
      for (const linea of p.PaymentInvoices ?? []) {
        const de = linea.DocEntry;
        if (de === null || de === undefined || !docEntries.has(de)) continue;
        // `$orderby=DocEntry desc` trae los mas nuevos primero, asi que el
        // primero que toca la factura es el ultimo pago que la afecto.
        if (!fechas.has(de)) fechas.set(de, fecha);
      }
    }
  }
  return { fechas, fallos };
}

/**
 * Sincroniza los pagos. Devuelve el resumen de lo que cambio.
 *
 * `folios` acota la corrida a unas facturas concretas; sin el, revisa todas las
 * que estan registradas en SAP y aun no constan como pagadas.
 */
export async function sincronizarPagos(opciones?: {
  folios?: readonly string[];
  actorId?: string;
  actorRole?: string;
}): Promise<ResumenSincronizacion> {
  const resumen: ResumenSincronizacion = {
    revisadas: 0,
    pagadas: [],
    parciales: [],
    sinFecha: [],
    errores: [],
  };

  const filtro: Record<string, unknown> = {
    status: { $in: SINCRONIZABLES },
    sapDocEntry: { $ne: null },
  };
  if (opciones?.folios?.length) filtro.folio = { $in: opciones.folios };

  const pendientes = await Invoice().find(filtro).limit(MAX_POR_CORRIDA).lean();
  resumen.revisadas = pendientes.length;
  if (pendientes.length === 0) return resumen;

  const porDocEntry = new Map<number, (typeof pendientes)[number]>();
  for (const f of pendientes) {
    const de = (f as { sapDocEntry?: number | null }).sapDocEntry;
    if (typeof de === "number") porDocEntry.set(de, f);
  }

  let enB1: Map<number, FacturaB1>;
  try {
    enB1 = await leerFacturas([...porDocEntry.keys()]);
  } catch (e) {
    for (const f of pendientes) {
      resumen.errores.push({
        folio: f.folio,
        motivo: e instanceof Error ? e.message : "No se pudo consultar Business One.",
      });
    }
    return resumen;
  }

  // Que facturas quedaron saldadas. El criterio es el importe, no el estatus:
  // `bost_Close` tambien aparece por otros motivos.
  const saldadas = new Set<number>();
  const parciales: Array<{ docEntry: number; total: number; pagado: number }> = [];

  for (const [docEntry, b1] of enB1) {
    const total = b1.DocTotal ?? 0;
    const pagado = b1.PaidToDate ?? 0;
    if (total > 0 && pagado >= total) saldadas.add(docEntry);
    else if (pagado > 0) parciales.push({ docEntry, total, pagado });
  }

  const { fechas, fallos } = saldadas.size
    ? await leerFechasDePago(
        [...saldadas].map((d) => enB1.get(d)?.CardCode ?? "").filter(Boolean),
        saldadas
      )
    : { fechas: new Map<number, string>(), fallos: [] as string[] };

  for (const f of fallos) {
    resumen.errores.push({ folio: "(lectura de pagos)", motivo: f });
  }

  const ahora = new Date();

  for (const docEntry of saldadas) {
    const local = porDocEntry.get(docEntry);
    const b1 = enB1.get(docEntry);
    if (!local || !b1) continue;

    const pagadaEl = fechas.get(docEntry) ?? null;
    const limite = pagadaEl ? limiteComplemento(pagadaEl) : null;

    // El filtro repite el estado: entre la lectura y esta escritura otra corrida
    // —o alguien a mano— pudo marcarla ya, y sin la condicion se duplicaria el
    // evento de bitacora sin que el estatus cambiara.
    const r = await Invoice().updateOne(
      { folio: local.folio, status: { $in: SINCRONIZABLES } },
      {
        $set: {
          status: "PAGADA",
          paidAt: pagadaEl ? new Date(`${pagadaEl}T00:00:00Z`) : ahora,
          paidMarkedAt: ahora,
          paidMarkedBy: opciones?.actorId ?? "sistema",
          sapPaidToDate: b1.PaidToDate ?? null,
          sapDocDueDate: b1.DocDueDate ? new Date(b1.DocDueDate) : null,
          complementoLimite: limite ? new Date(`${limite}T00:00:00Z`) : null,
        },
      }
    );
    if (r.modifiedCount === 0) continue;

    await InvoiceEvent().create({
      invoiceFolio: local.folio,
      fromStatus: local.status,
      toStatus: "PAGADA",
      actorId: opciones?.actorId ?? "sistema",
      actorRole: opciones?.actorRole ?? "SINCRONIZACION",
      comment: pagadaEl
        ? `Business One registra el pago de la factura ${b1.DocNum} el ${pagadaEl}. El complemento de pago se puede emitir hasta el ${limite}.`
        : `Business One da por pagada la factura ${b1.DocNum}. No se encontro el pago que la salda, asi que no consta la fecha exacta.`,
      payload: { docEntry, docNum: b1.DocNum, pagadaEl, limiteComplemento: limite },
      createdAt: ahora,
    });

    await AuditLog().create({
      entityType: "invoice",
      entityId: local.folio,
      action: "FACTURA_PAGADA_DETECTADA",
      actorId: opciones?.actorId ?? "sistema",
      actorRole: opciones?.actorRole ?? "SINCRONIZACION",
      before: { status: local.status },
      after: { status: "PAGADA", pagadaEl, limiteComplemento: limite },
      comment: null,
      createdAt: ahora,
    });

    resumen.pagadas.push({ folio: local.folio, docNum: b1.DocNum, pagadaEl, limiteComplemento: limite });
    if (!pagadaEl) resumen.sinFecha.push({ folio: local.folio, docNum: b1.DocNum });
  }

  // Los pagos parciales NO cambian el estatus: la factura sigue debiendose y su
  // vencimiento es el mismo. Se reportan para que quien mire la bandeja lo sepa,
  // y se guarda lo pagado para poder ensenarlo.
  for (const p of parciales) {
    const local = porDocEntry.get(p.docEntry);
    const b1 = enB1.get(p.docEntry);
    if (!local || !b1) continue;
    await Invoice().updateOne(
      { folio: local.folio },
      {
        $set: {
          sapPaidToDate: p.pagado,
          sapDocDueDate: b1.DocDueDate ? new Date(b1.DocDueDate) : null,
        },
      }
    );
    resumen.parciales.push({ folio: local.folio, docNum: b1.DocNum, total: p.total, pagado: p.pagado });
  }

  return resumen;
}
