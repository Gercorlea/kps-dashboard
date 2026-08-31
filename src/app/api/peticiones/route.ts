import { handleApiError, ok } from "@/lib/api";
import { requireModule } from "@/lib/auth/guards";
import { Invoice, Supplier } from "@/models/proveedores";

// Bandeja de peticiones: las facturas que los proveedores enviaron por el
// portal y esperan decisión de KPS.

export const runtime = "nodejs";

/** Estados en los que la factura ya no se mueve. */
const CERRADAS = ["CERRADA", "RECHAZADA", "DUPLICADA", "PAGADA"];

/** Lo que espera trabajo de KPS. */
export const PENDIENTES = ["EN_REVISION", "NC_EN_REVISION"];

function importe(v: unknown): string {
  // Decimal128 llega como objeto; `String()` da el valor exacto sin pasar por
  // coma flotante, que es justo lo que no se puede hacer con dinero.
  if (v === null || v === undefined) return "0.00";
  return String(v);
}

export async function GET(req: Request) {
  try {
    await requireModule("peticiones");

    const url = new URL(req.url);
    const estatus = url.searchParams.get("estatus")?.trim();

    // Archivar saca la petición de la bandeja sin borrarla, así que TODAS las
    // vistas la excluyen salvo la suya propia. Se comprueba contra null y no
    // con `$exists` porque los documentos que escribió el portal antes de que
    // este campo existiera no lo traen: `archivedAt: null` y campo ausente
    // significan lo mismo —no archivada— y `$in: [null]` cubre los dos casos.
    const visible = { archivedAt: { $in: [null] } };

    const filtro: Record<string, unknown> =
      estatus === "archivadas"
        ? { archivedAt: { $ne: null } }
        : estatus === "pendientes"
          ? { ...visible, status: { $in: PENDIENTES } }
          : estatus === "cerradas"
            ? { ...visible, status: { $in: CERRADAS } }
            : estatus
              ? { ...visible, status: estatus }
              : visible;

    const facturas = await Invoice()
      .find(filtro)
      .sort({ submittedAt: -1, createdAt: -1 })
      .limit(200)
      .lean();

    // Los nombres, en una sola consulta: resolverlos uno por uno sería una
    // consulta por fila de la tabla.
    const codigos = [...new Set(facturas.map((f) => f.supplierCode))];
    const proveedores = await Supplier()
      .find({ supplierCode: { $in: codigos } }, { supplierCode: 1, legalName: 1 })
      .lean();
    const nombres = new Map(proveedores.map((s) => [String(s.supplierCode), s.legalName]));

    // El contador de la cabecera cuenta trabajo por hacer, y una petición
    // archivada ya no lo es. Sin este filtro el título diría "2 pendientes"
    // sobre una bandeja vacía.
    const pendientes = await Invoice().countDocuments({
      ...visible,
      status: { $in: PENDIENTES },
    });

    return ok({
      pendientes,
      peticiones: facturas.map((f) => ({
        folio: f.folio,
        uuid: f.uuid ?? null,
        tipo: f.type,
        estatus: f.status,
        cardCode: f.supplierCode,
        proveedor: nombres.get(f.supplierCode) ?? f.supplierCode,
        total: importe(f.total),
        moneda: f.currency ?? "MXN",
        ordenCompra: f.poNumber ?? null,
        enviada: (f.submittedAt ?? f.createdAt)?.toISOString() ?? null,
        archivada: f.archivedAt?.toISOString() ?? null,
        motivoArchivo: f.archiveReason ?? null,
        xmlFileKey: f.xmlFileKey ?? null,
        pdfFileKey: f.pdfFileKey ?? null,
        evidencias: Array.isArray(f.evidence) ? f.evidence.length : 0,
      })),
    });
  } catch (e) {
    return handleApiError(e);
  }
}
