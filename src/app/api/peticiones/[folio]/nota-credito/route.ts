import { z } from "zod";
import { ApiError, handleApiError, ok, parseJson } from "@/lib/api";
import { requireModule } from "@/lib/auth/guards";
import { AuditLog, CreditNote, Invoice, InvoiceEvent } from "@/models/proveedores";

// La nota de crédito que un proveedor subió contra una factura, y su decisión.
//
// POR QUÉ CUELGA DE LA PETICIÓN Y NO DE UNA PANTALLA PROPIA. La factura en
// NC_EN_REVISION ya sale en la bandeja —`PENDIENTES` la incluye—, así que una
// sección aparte obligaría a cruzar a mano qué nota era de qué factura. Eso es
// justo el trabajo manual que el portal existe para quitar.
//
// EL PORTAL YA VALIDÓ LO FISCAL: que sea CFDI de tipo E, que relacione el UUID
// de la factura con clave 01 o 03, que sea del mismo ejercicio, la moneda y que
// no acredite más de lo facturado. Aquí no se repite nada de eso; lo que falta
// es la decisión humana.

export const runtime = "nodejs";

/** Decimal128 llega como objeto: `String()` da el valor exacto, sin flotantes. */
function importe(v: unknown): string {
  if (v === null || v === undefined) return "0.00";
  return String(v);
}

export async function GET(_req: Request, { params }: { params: Promise<{ folio: string }> }) {
  try {
    await requireModule("peticiones");
    const { folio } = await params;

    const notas = await CreditNote().find({ invoiceFolio: folio }).sort({ createdAt: -1 }).lean();

    return ok({
      notas: notas.map((n) => ({
        id: String(n._id),
        uuid: n.uuid,
        importe: importe(n.amount),
        moneda: n.currency ?? "MXN",
        emitida: n.issueDate?.toISOString() ?? null,
        cargada: n.createdAt?.toISOString() ?? null,
        estatus: n.status,
        motivo: n.reason ?? null,
        revisadaPor: n.reviewedBy ?? null,
        revisadaEl: n.reviewedAt?.toISOString() ?? null,
        sapDocEntry: n.sapDocEntry ?? null,
        xml: n.xmlFileKey,
        pdf: n.pdfFileKey,
      })),
    });
  } catch (e) {
    return handleApiError(e);
  }
}

const EsquemaDecision = z.object({
  decision: z.enum(["APROBAR", "RECHAZAR"]),
  motivo: z.string().trim().max(1000).optional(),
});

/**
 * A dónde va la FACTURA según lo que se decida sobre su nota.
 *
 * Aprobar la nota deja la factura lista para pago: la diferencia que la frenaba
 * ya está acreditada. Rechazarla la devuelve a NC_SOLICITADA —no a EN_REVISION—
 * porque lo que se le pidió al proveedor sigue pendiente: hace falta OTRA nota,
 * no que KPS vuelva a revisar la misma factura.
 */
const DESTINO_FACTURA = {
  APROBAR: "APROBADA_PAGO",
  RECHAZAR: "NC_SOLICITADA",
} as const;

export async function PATCH(req: Request, { params }: { params: Promise<{ folio: string }> }) {
  try {
    const usuario = await requireModule("peticiones");
    const { folio } = await params;
    const { decision, motivo } = await parseJson(req, EsquemaDecision);

    // Rechazar exige motivo: el proveedor lo recibe y sin él no sabe qué
    // corregir en la nota que tiene que volver a emitir.
    const comentario = motivo?.trim() ?? "";
    if (decision === "RECHAZAR" && comentario.length === 0) {
      throw new ApiError(
        400,
        "MOTIVO_REQUERIDO",
        "Escribe por qué se rechaza: es lo que va a leer el proveedor."
      );
    }

    const nota = await CreditNote().findOne({ invoiceFolio: folio, status: "PENDIENTE" }).lean();
    if (!nota) {
      throw new ApiError(
        404,
        "NO_ENCONTRADO",
        `La factura ${folio} no tiene ninguna nota de crédito por revisar.`
      );
    }

    const factura = await Invoice().findOne({ folio }).lean();
    if (!factura) throw new ApiError(404, "NO_ENCONTRADO", `No existe la petición ${folio}.`);

    const ahora = new Date();
    const destino = DESTINO_FACTURA[decision];

    // El filtro repite el estado de partida: entre el findOne y este update cabe
    // que otra persona resuelva la misma nota.
    const r = await CreditNote().updateOne(
      { _id: nota._id, status: "PENDIENTE" },
      {
        $set: {
          status: decision === "APROBAR" ? "APROBADA" : "RECHAZADA",
          reviewedBy: usuario.id,
          reviewedAt: ahora,
          reason: comentario || null,
        },
      }
    );
    if (r.matchedCount === 0) {
      throw new ApiError(
        409,
        "ESTADO_INVALIDO",
        `Alguien más acaba de resolver la nota de ${folio}. Recarga la bandeja.`
      );
    }

    await Invoice().updateOne(
      { folio },
      {
        $set: {
          status: destino,
          reviewedBy: usuario.id,
          reviewedAt: ahora,
          updatedAt: ahora,
        },
      }
    );

    // §11: el cambio de estatus deja rastro. El portal materializa sus avisos a
    // partir de estos eventos, así que sin ellos el proveedor no se entera.
    await InvoiceEvent().create({
      invoiceFolio: folio,
      fromStatus: factura.status,
      toStatus: destino,
      actorId: usuario.id,
      actorRole: usuario.role,
      comment:
        decision === "APROBAR"
          ? `KPS aprobó la nota de crédito ${nota.uuid} por ${importe(nota.amount)} ${nota.currency ?? "MXN"}.`
          : comentario,
      createdAt: ahora,
    });

    await AuditLog().create({
      entityType: "invoice",
      entityId: folio,
      action: decision === "APROBAR" ? "NOTA_CREDITO_APROBADA" : "NOTA_CREDITO_RECHAZADA",
      actorId: usuario.id,
      actorRole: usuario.role,
      before: { status: factura.status },
      after: { status: destino, notaCredito: nota.uuid },
      comment: comentario || null,
      createdAt: ahora,
    });

    // NO SE REGISTRA EN BUSINESS ONE TODAVÍA. La nota queda APROBADA y con
    // `sapDocEntry` en null, que es la marca de "falta aplicarla en B1".
    // Registrarla es crear una Nota de crédito de proveedores copiando de la
    // factura (BaseType 18), y eso es una escritura a SAP: va por la cola, no
    // dentro de este request.
    return ok({
      folio,
      uuid: nota.uuid,
      notaEstatus: decision === "APROBAR" ? "APROBADA" : "RECHAZADA",
      facturaEstatus: destino,
      pendienteEnSap: decision === "APROBAR",
    });
  } catch (e) {
    return handleApiError(e);
  }
}
