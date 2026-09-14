import { ApiError, handleApiError, ok } from "@/lib/api";
import { requireModule } from "@/lib/auth/guards";
import { sendOperationalEmail } from "@/lib/email";
import { crearExcelDispersion, filasDispersion } from "@/lib/proveedores/dispersion";
import { aplicarBloqueosComplemento } from "@/lib/proveedores/complementos";
import { AuditLog, Invoice, InvoiceEvent } from "@/models/proveedores";

export const runtime = "nodejs";

function nombreArchivo() {
  return `dispersion-kps-${new Date().toISOString().slice(0, 10)}.xlsx`;
}

export async function GET(req: Request) {
  try {
    await requireModule("peticiones");
    const incluirEnviadas = new URL(req.url).searchParams.get("todas") === "1";
    const filas = await filasDispersion(incluirEnviadas);
    if (!filas.length) throw new ApiError(404, "SIN_FACTURAS", "No hay facturas liberadas pendientes de dispersión.");
    const bytes = await crearExcelDispersion(filas);
    // La copia garantiza un ArrayBuffer normal (no SharedArrayBuffer), que es
    // el BodyInit aceptado por Next/undici y conserva todos los bytes del XLSX.
    const cuerpo = Uint8Array.from(bytes).buffer;
    return new Response(cuerpo, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${nombreArchivo()}"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (e) {
    return handleApiError(e);
  }
}

export async function POST() {
  try {
    const usuario = await requireModule("peticiones");
    const destino = process.env.TESORERIA_EMAIL?.trim();
    if (!destino) throw new ApiError(503, "SIN_DESTINO", "Configura TESORERIA_EMAIL antes de enviar la dispersión.");
    // Antes de programar pagos se reevalúan los complementos: un proveedor con
    // REP vencido no puede colarse entre la última corrida nocturna y el envío.
    await aplicarBloqueosComplemento();
    const filas = await filasDispersion(false);
    if (!filas.length) throw new ApiError(404, "SIN_FACTURAS", "No hay facturas liberadas pendientes de dispersión.");
    const incompletas = filas.filter((f) => !f.datosBancariosCompletos);
    if (incompletas.length) {
      throw new ApiError(422, "DATOS_BANCARIOS_INCOMPLETOS", `${incompletas.length} factura(s) no tienen banco y cuenta o CLABE completos.`, {
        folios: incompletas.map((f) => f.folioPortal),
      });
    }
    const archivo = await crearExcelDispersion(filas);
    await sendOperationalEmail({
      to: destino,
      subject: `KPS · dispersión de ${filas.length} pago(s)`,
      title: "Archivo de dispersión autorizado",
      paragraphs: [`Se adjuntan ${filas.length} pagos liberados por cuentas por pagar.`, "El pago se ejecuta y concilia en SAP Business One."],
      attachment: { filename: nombreArchivo(), content: archivo },
    });

    const ahora = new Date();
    const folios = filas.map((f) => f.folioPortal);
    await Promise.all(filas.map(async (fila) => {
      const cambio = await Invoice().updateOne(
        { folio: fila.folioPortal, status: { $in: ["REGISTRADA_SAP", "CUENTAS_POR_PAGAR"] }, disbursementSentAt: { $in: [null] } },
        { $set: { status: "CUENTAS_POR_PAGAR", disbursementSentAt: ahora, disbursementSentBy: usuario.id } }
      );
      if (cambio.modifiedCount === 0) return;
      await InvoiceEvent().create({
        invoiceFolio: fila.folioPortal,
        fromStatus: fila.estado,
        toStatus: "CUENTAS_POR_PAGAR",
        actorId: usuario.id,
        actorRole: usuario.role,
        comment: `Incluida en el archivo enviado a tesorería el ${ahora.toISOString()}.`,
        payload: { destino },
        createdAt: ahora,
      });
    }));
    await AuditLog().create({
      entityType: "disbursement",
      entityId: ahora.toISOString(),
      action: "DISPERSION_ENVIADA",
      actorId: usuario.id,
      actorRole: usuario.role,
      before: null,
      after: { folios, totalFacturas: folios.length },
      comment: `Archivo enviado a ${destino}.`,
      createdAt: ahora,
    });
    return ok({ enviadas: folios.length, folios, destino });
  } catch (e) {
    return handleApiError(e);
  }
}
