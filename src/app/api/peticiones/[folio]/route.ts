import Decimal from "decimal.js";
import { z } from "zod";
import { ApiError, handleApiError, ok, parseJson } from "@/lib/api";
import { requireModule, requireSuperadmin } from "@/lib/auth/guards";
import { sapFetch } from "@/lib/sap/service-layer";
import { calcularCobertura, type Cobertura, type LineaFacturada } from "@/lib/proveedores/cobertura";
import { registrarFacturaEnSap, RegistroSapError, REGISTRABLE } from "@/lib/proveedores/registrar-sap";
import { AuditLog, Invoice, InvoiceEvent, Supplier, ValidationResult } from "@/models/proveedores";

// Detalle de una petición y decisión de KPS sobre ella.

export const runtime = "nodejs";

function importe(v: unknown): string {
  if (v === null || v === undefined) return "0.00";
  return String(v);
}

/** Estados en los que una factura YA consume la orden. */
const APROBADAS = [
  "APROBADA_PAGO",
  "REGISTRADA_SAP",
  "CUENTAS_POR_PAGAR",
  "PAGADA",
  "CERRADA",
];

interface LineaSap {
  LineNum: number;
  ItemCode?: string | null;
  ItemDescription?: string | null;
  Quantity: number;
}

/** Las lineas de una factura del portal, en la forma que espera el calculo. */
function lineasDe(doc: { lines?: unknown[] }): LineaFacturada[] {
  return (doc.lines ?? []).map((l) => {
    const x = l as { noIdentidad?: string | null; description?: string; quantity?: unknown };
    return {
      itemCode: x.noIdentidad ?? null,
      description: x.description ?? "",
      // Decimal128 llega como objeto; String() da el valor exacto sin pasar por
      // coma flotante.
      quantity: new Decimal(String(x.quantity ?? 0)),
    };
  });
}

/**
 * Cuanto de la orden cubre esta factura y cuanto sigue faltando.
 *
 * Devuelve null cuando no se puede saber —factura sin orden, o B1 no responde—.
 * Es distinto de "no falta nada", y la pantalla lo dice con esas palabras: dar
 * por cubierto lo que no se pudo comprobar es como se aprueba de mas.
 */
async function coberturaDe(
  poNumber: string | null,
  folio: string,
  supplierCode: string,
  esta: LineaFacturada[]
): Promise<(Cobertura & { totalOrden: number; monedaOrden: string }) | null> {
  if (!poNumber) return null;

  let orden: { DocumentLines?: LineaSap[]; DocTotal?: number; DocCurrency?: string } | undefined;
  try {
    const data = await sapFetch<{
      value?: { DocumentLines?: LineaSap[]; DocTotal?: number; DocCurrency?: string }[];
    }>(
      `/PurchaseOrders?$filter=DocNum eq ${Number(poNumber)}&$top=1`
    );
    orden = data.value?.[0];
  } catch {
    return null;
  }
  if (!orden?.DocumentLines?.length) return null;

  // Las ya aprobadas de ESTA orden, sin contar la que se esta revisando: si se
  // contara a si misma, su propia cantidad apareceria como "ya facturado antes".
  const previas = await Invoice()
    .find(
      { poNumber, supplierCode, status: { $in: APROBADAS }, folio: { $ne: folio } },
      { lines: 1 }
    )
    .lean();

  const cobertura = calcularCobertura({
    orden: orden.DocumentLines.map((l) => ({
      lineNum: l.LineNum,
      itemCode: l.ItemCode ?? null,
      description: l.ItemDescription ?? "",
      quantity: new Decimal(l.Quantity ?? 0),
    })),
    aprobadas: previas.flatMap((d) => lineasDe(d as { lines?: unknown[] })),
    enCurso: esta,
  });

  // El total de la orden viaja con la cobertura para poder pintar la resta de
  // importes junto a la de cantidades, sin una segunda llamada a B1.
  return {
    ...cobertura,
    totalOrden: orden.DocTotal ?? 0,
    monedaOrden: orden.DocCurrency ?? "MXP",
  };
}

export async function GET(_req: Request, { params }: { params: Promise<{ folio: string }> }) {
  try {
    await requireModule("peticiones");
    const { folio } = await params;

    const f = await Invoice().findOne({ folio }).lean();
    if (!f) throw new ApiError(404, "NO_ENCONTRADO", `No existe la petición ${folio}.`);

    const [proveedor, reglas, eventos, cobertura] = await Promise.all([
      Supplier().findOne({ supplierCode: f.supplierCode }).lean(),
      ValidationResult().find({ invoiceFolio: folio }).sort({ ranAt: 1 }).lean(),
      InvoiceEvent().find({ invoiceFolio: folio }).sort({ createdAt: 1 }).lean(),
      coberturaDe(f.poNumber ?? null, folio, f.supplierCode, lineasDe(f as { lines?: unknown[] })),
    ]);

    return ok({
      peticion: {
        folio: f.folio,
        uuid: f.uuid ?? null,
        serie: f.serie ?? null,
        tipo: f.type,
        estatus: f.status,
        cardCode: f.supplierCode,
        proveedor: proveedor?.legalName ?? f.supplierCode,
        rfcEmisor: f.issuerTaxId ?? null,
        rfcReceptor: f.receiverTaxId ?? null,
        fechaEmision: f.issueDate?.toISOString() ?? null,
        subtotal: importe(f.subtotal),
        trasladados: importe(f.taxTransferred),
        retenidos: importe(f.taxWithheld),
        total: importe(f.total),
        moneda: f.currency ?? "MXN",
        metodoPago: f.paymentMethod ?? null,
        formaPago: f.paymentForm ?? null,
        ordenCompra: f.poNumber ?? null,
        entrada: f.goodsReceiptNumber ?? null,
        xmlFileKey: f.xmlFileKey ?? null,
        pdfFileKey: f.pdfFileKey ?? null,
        evidencias: Array.isArray(f.evidence) ? f.evidence : [],
        conceptos: Array.isArray(f.lines) ? f.lines : [],
        motivoRechazo: f.rejectionReason ?? null,
        enviada: (f.submittedAt ?? f.createdAt)?.toISOString() ?? null,
      },
      validaciones: reglas.map((r) => ({
        regla: r.rule,
        severidad: r.severity,
        pasa: r.passed,
        detalle: r.detail,
      })),
      cobertura,
      bitacora: eventos.map((e) => ({
        de: e.fromStatus,
        a: e.toStatus,
        comentario: e.comment,
        cuando: e.createdAt?.toISOString() ?? null,
      })),
    });
  } catch (e) {
    return handleApiError(e);
  }
}

/**
 * Decisiones y a qué estado llevan.
 *
 * `corregir` devuelve la factura al proveedor sin cerrarla: puede subir una
 * nueva. `rechazar` la cierra. Se separan porque no son lo mismo para quien la
 * envió, y juntarlas obligaría al proveedor a adivinar si vuelve a intentarlo.
 */
const DESTINO = {
  aprobar: "APROBADA_PAGO",
  corregir: "EN_CORRECCION",
  rechazar: "RECHAZADA",
} as const;

/** Solo se decide sobre lo que está esperando decisión. */
const DECIDIBLES = ["EN_REVISION", "NC_EN_REVISION"];

const EsquemaDecision = z.object({
  decision: z.enum(["aprobar", "corregir", "rechazar"]),
  motivo: z.string().trim().max(1000).optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ folio: string }> }) {
  try {
    const usuario = await requireModule("peticiones");
    const { folio } = await params;
    const { decision, motivo } = await parseJson(req, EsquemaDecision);

    const f = await Invoice().findOne({ folio }).lean();
    if (!f) throw new ApiError(404, "NO_ENCONTRADO", `No existe la petición ${folio}.`);

    if (!DECIDIBLES.includes(f.status)) {
      throw new ApiError(
        409,
        "ESTADO_INVALIDO",
        `La petición ${folio} está en ${f.status} y ya no admite decisión.`
      );
    }

    // Devolver o rechazar sin decir por qué deja al proveedor sin nada que
    // corregir. §06 es explícito: no se le dice "no" sin decirle qué falla.
    if (decision !== "aprobar" && !motivo) {
      throw new ApiError(
        422,
        "FALTA_MOTIVO",
        decision === "corregir"
          ? "Explica qué tiene que corregir el proveedor."
          : "Explica por qué se rechaza la factura."
      );
    }

    const destino = DESTINO[decision];
    const ahora = new Date();

    // El filtro repite el estado: entre el `findOne` de arriba y este update
    // otra persona pudo decidir la misma petición, y sin esta condición la
    // segunda decisión pisaría a la primera en silencio.
    const r = await Invoice().updateOne(
      { folio, status: { $in: DECIDIBLES } },
      {
        $set: {
          status: destino,
          reviewedBy: usuario.id,
          reviewedAt: ahora,
          rejectionReason: decision === "aprobar" ? null : (motivo ?? null),
        },
      }
    );

    if (r.matchedCount === 0) {
      throw new ApiError(
        409,
        "ESTADO_INVALIDO",
        `Alguien más acaba de decidir sobre ${folio}. Recarga la bandeja.`
      );
    }

    // Bitácora: §11 pide un evento por cada cambio de estatus, con quién y
    // cuándo. Va después del update y no dentro de una transacción porque esta
    // conexión puede apuntar a un despliegue sin replica set; el riesgo es un
    // evento perdido, no un estatus a medias.
    await InvoiceEvent().create({
      invoiceFolio: folio,
      fromStatus: f.status,
      toStatus: destino,
      actorId: usuario.id,
      actorRole: usuario.role,
      comment: motivo ?? "Aprobada para pago.",
      payload: { decision },
      createdAt: ahora,
    });

    await AuditLog().create({
      entityType: "invoice",
      entityId: folio,
      action: `FACTURA_${decision.toUpperCase()}`,
      actorId: usuario.id,
      actorRole: usuario.role,
      before: { status: f.status },
      after: { status: destino },
      comment: motivo ?? null,
      createdAt: ahora,
    });

    // --- Registro en Business One ------------------------------------------
    // Solo al aprobar, y DESPUÉS de que la decisión quede escrita: la aprobación
    // es de KPS y vale por sí sola. Si SAP falla, la factura se queda en
    // APROBADA_PAGO —no se revierte la decisión— y se devuelve el motivo para
    // que quien revisa sepa que falta ese paso y pueda reintentarlo.
    //
    // El reintento es seguro: `registrarFacturaEnSap` busca por UUID antes de
    // crear, así que aunque la factura ya haya entrado no se duplica.
    if (decision !== "aprobar") return ok({ folio, estatus: destino });

    try {
      const sap = await registrarFacturaEnSap({
        folio,
        actorId: usuario.id,
        actorRole: usuario.role,
      });
      return ok({
        folio,
        estatus: "REGISTRADA_SAP",
        sap: {
          registrada: true,
          docEntry: sap.docEntry,
          docNum: sap.docNum,
          reusada: sap.reusada,
          avisoAdjuntos: sap.avisoAdjuntos,
        },
      });
    } catch (e) {
      if (e instanceof RegistroSapError) {
        return ok({
          folio,
          estatus: destino,
          sap: { registrada: false, motivo: e.motivo, detalle: e.message },
        });
      }
      throw e;
    }
  } catch (e) {
    return handleApiError(e);
  }
}

/**
 * Archivar y restaurar una petición.
 *
 * ARCHIVAR NO ES BORRAR, y la diferencia es deliberada. Una petición es un CFDI
 * que el proveedor emitió: el documento, sus validaciones, su bitácora y sus
 * archivos siguen exactamente donde estaban, y `status` no se toca. Lo único que
 * cambia es que deja de aparecer en la bandeja. Restaurar la devuelve al estado
 * en que estaba, sin reconstruir nada, porque nunca se perdió nada.
 *
 * Borrar de verdad tampoco tendría a dónde ir: §11 define la bitácora como
 * append-only, y un `deleteOne` dejaría eventos de auditoría apuntando a un
 * folio inexistente.
 *
 * Va con `requireSuperadmin` y no con `requireModule("peticiones")`: quien
 * revisa aprueba y rechaza —decisiones que el proveedor ve y puede responder—,
 * mientras que archivar esconde la petición de la vista de todos los demás.
 */
const EsquemaArchivo = z.object({
  archivada: z.boolean(),
  motivo: z.string().trim().max(500).optional(),
});

export async function PATCH(req: Request, { params }: { params: Promise<{ folio: string }> }) {
  try {
    const usuario = await requireSuperadmin();
    const { folio } = await params;
    const { archivada, motivo } = await parseJson(req, EsquemaArchivo);

    const f = await Invoice().findOne({ folio }).lean();
    if (!f) throw new ApiError(404, "NO_ENCONTRADO", `No existe la petición ${folio}.`);

    const yaArchivada = f.archivedAt != null;
    if (yaArchivada === archivada) {
      throw new ApiError(
        409,
        "ESTADO_INVALIDO",
        archivada
          ? `La petición ${folio} ya estaba archivada.`
          : `La petición ${folio} no está archivada.`
      );
    }

    const ahora = new Date();

    // El filtro repite la condición de partida por lo mismo que en POST: entre
    // el findOne y este update cabe que otra persona archive la misma petición.
    const r = await Invoice().updateOne(
      { folio, archivedAt: archivada ? { $in: [null] } : { $ne: null } },
      {
        $set: archivada
          ? { archivedAt: ahora, archivedBy: usuario.id, archiveReason: motivo ?? null }
          : { archivedAt: null, archivedBy: null, archiveReason: null },
      }
    );

    if (r.matchedCount === 0) {
      throw new ApiError(
        409,
        "ESTADO_INVALIDO",
        `Alguien más acaba de cambiar ${folio}. Recarga la bandeja.`
      );
    }

    // Sin InvoiceEvent: esa bitácora es la del ciclo de vida de la factura y se
    // le enseña al proveedor. Archivar no cambia su situación ni le pide nada,
    // así que ensuciaría su historial con un movimiento que no le concierne. El
    // rastro va al AuditLog, que es el registro interno de quién hizo qué.
    await AuditLog().create({
      entityType: "invoice",
      entityId: folio,
      action: archivada ? "PETICION_ARCHIVADA" : "PETICION_RESTAURADA",
      actorId: usuario.id,
      actorRole: usuario.role,
      before: { archivada: yaArchivada },
      after: { archivada },
      comment: motivo ?? null,
      createdAt: ahora,
    });

    return ok({ folio, archivada });
  } catch (e) {
    return handleApiError(e);
  }
}

/**
 * Reintentar el registro en Business One de una factura ya aprobada.
 *
 * POR QUE HACE FALTA. La aprobación y el registro son dos hechos distintos y el
 * segundo falla por motivos que no tienen nada que ver con la decisión de KPS:
 * B1 caído, la entrada anulada entre medias, un artículo que pide lote. Cuando
 * eso pasa la factura se queda en APROBADA_PAGO —la aprobación no se revierte,
 * porque sigue siendo válida— y sin esta ruta no habría forma de completarla:
 * el POST de decisión solo admite EN_REVISION, así que volver a pulsar
 * "aprobar" responde 409 y la petición se queda encallada para siempre.
 *
 * ES SEGURO REPETIRLO. `registrarFacturaEnSap` busca la factura por el UUID del
 * CFDI antes de crear nada, así que si el intento anterior llegó a escribir en
 * B1 —y lo que falló fue el guardado local— este reintento la encuentra, la
 * enlaza y no crea un duplicado.
 */
export async function PUT(_req: Request, { params }: { params: Promise<{ folio: string }> }) {
  try {
    const usuario = await requireModule("peticiones");
    const { folio } = await params;

    const f = await Invoice().findOne({ folio }).lean();
    if (!f) throw new ApiError(404, "NO_ENCONTRADO", `No existe la petición ${folio}.`);

    if (f.status !== REGISTRABLE) {
      throw new ApiError(
        409,
        "ESTADO_INVALIDO",
        `${folio} está en ${f.status}. Solo se reintenta el registro de una factura aprobada y todavía sin registrar.`
      );
    }

    try {
      const sap = await registrarFacturaEnSap({
        folio,
        actorId: usuario.id,
        actorRole: usuario.role,
      });
      return ok({
        folio,
        estatus: "REGISTRADA_SAP",
        sap: {
          registrada: true,
          docEntry: sap.docEntry,
          docNum: sap.docNum,
          reusada: sap.reusada,
          avisoAdjuntos: sap.avisoAdjuntos,
        },
      });
    } catch (e) {
      if (e instanceof RegistroSapError) {
        // 200 y no error: la petición se atendió y la respuesta dice por qué no
        // entró. Un 5xx haría pensar que el reintento ni se ejecutó.
        return ok({
          folio,
          estatus: f.status,
          sap: { registrada: false, motivo: e.motivo, detalle: e.message },
        });
      }
      throw e;
    }
  } catch (e) {
    return handleApiError(e);
  }
}
