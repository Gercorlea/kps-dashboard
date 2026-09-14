import { randomUUID } from "node:crypto";
import { ApiError, handleApiError, ok } from "@/lib/api";
import { requireModule } from "@/lib/auth/guards";
import { sendOperationalEmail } from "@/lib/email";
import { AuditLog, Invoice, PortalUser, StoredDocument } from "@/models/proveedores";

export const runtime = "nodejs";

const MAX_BYTES = 10 * 1024 * 1024;
const TIPOS = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp"]);

export async function POST(req: Request, { params }: { params: Promise<{ folio: string }> }) {
  try {
    const usuario = await requireModule("peticiones");
    const { folio } = await params;
    const factura = await Invoice().findOne({ folio }).lean();
    if (!factura) throw new ApiError(404, "NO_ENCONTRADO", `No existe la petición ${folio}.`);
    if (factura.status !== "PAGADA") {
      throw new ApiError(409, "PAGO_PENDIENTE", "El comprobante se habilita cuando SAP confirma el pago.");
    }

    const form = await req.formData();
    const archivo = form.get("archivo");
    if (!(archivo instanceof File)) throw new ApiError(422, "SIN_ARCHIVO", "Selecciona el comprobante de transferencia.");
    if (!TIPOS.has(archivo.type)) throw new ApiError(422, "TIPO_INVALIDO", "El comprobante debe ser PDF, JPG, PNG o WEBP.");
    if (archivo.size <= 0 || archivo.size > MAX_BYTES) throw new ApiError(422, "TAMANO_INVALIDO", "El comprobante debe pesar entre 1 byte y 10 MB.");

    const ahora = new Date();
    const limite = new Date(ahora.getTime() + 5 * 86_400_000);
    const key = randomUUID();
    await StoredDocument().create({
      _id: key,
      filename: archivo.name.slice(0, 180),
      contentType: archivo.type,
      size: archivo.size,
      bytes: Buffer.from(await archivo.arrayBuffer()),
      purpose: "PAYMENT_RECEIPT",
      supplierCode: factura.supplierCode,
      createdAt: ahora,
    });

    await Invoice().updateOne({ folio, status: "PAGADA" }, { $set: {
      transferReceiptFileKey: key,
      transferReceiptUploadedAt: ahora,
      transferReceiptUploadedBy: usuario.id,
      complementStatus: "PENDIENTE",
      complementDueAt: limite,
    } });
    await AuditLog().create({
      entityType: "invoice",
      entityId: folio,
      action: "COMPROBANTE_TRANSFERENCIA_CARGADO",
      actorId: usuario.id,
      actorRole: usuario.role,
      before: null,
      after: { fileKey: key, complementDueAt: limite },
      comment: "La carga habilita al proveedor para adjuntar su complemento de pago.",
      createdAt: ahora,
    });
    const accesos = await PortalUser().find({ supplierCode: factura.supplierCode, active: true }, { email: 1 }).lean();
    let avisoCorreo: string | null = null;
    if (accesos.length) {
      try {
        await sendOperationalEmail({
          to: accesos.map((u) => u.email),
          subject: `KPS · comprobante disponible para ${folio}`,
          title: "Pago confirmado",
          paragraphs: [
            `Tesorería cargó el comprobante de la factura ${folio}.`,
            `Ya puedes cargar el complemento de pago; el plazo termina el ${limite.toISOString().slice(0, 10)}.`,
          ],
        });
      } catch (e) {
        avisoCorreo = e instanceof Error ? e.message : "No se pudo notificar al proveedor.";
      }
    } else {
      avisoCorreo = "El proveedor no tiene un correo de acceso activo.";
    }
    return ok({ folio, fileKey: key, complementoLimite: limite.toISOString(), avisoCorreo }, { status: 201 });
  } catch (e) {
    return handleApiError(e);
  }
}
