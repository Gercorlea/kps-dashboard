import { ApiError, handleApiError, ok } from "@/lib/api";
import { requireModule } from "@/lib/auth/guards";
import { sendOperationalEmail } from "@/lib/email";
import { reporteFacturasProveedores } from "@/lib/proveedores/reportes";
import { aplicarBloqueosComplemento } from "@/lib/proveedores/complementos";
import { AuditLog } from "@/models/proveedores";

export const runtime = "nodejs";

async function procesar(usuario: { id: string; role: string }) {
    const bloqueos = await aplicarBloqueosComplemento();
    const cuentasPorPagar = process.env.CUENTAS_POR_PAGAR_EMAIL?.trim();
    if (!cuentasPorPagar) {
      throw new ApiError(503, "SIN_DESTINO", "Configura CUENTAS_POR_PAGAR_EMAIL para enviar alertas.");
    }
    const pendientes = await reporteFacturasProveedores("pendientes");
    if (!pendientes.length) return { pendientes: 0, escaladas: 0, bloqueos, mensaje: "No hay facturas pendientes." };

    const escaladas = pendientes.filter((f) => (f.horasSinLiberar ?? 0) >= 48);
    await sendOperationalEmail({
      to: cuentasPorPagar,
      subject: `KPS · ${pendientes.length} factura(s) pendientes de liberar`,
      title: "Facturas pendientes de liberación",
      paragraphs: [
        `${pendientes.length} factura(s) esperan una decisión de cuentas por pagar.`,
        `La más antigua lleva ${Math.max(...pendientes.map((f) => f.horasSinLiberar ?? 0))} horas sin liberar.`,
        `Folios: ${pendientes.map((f) => f.folio).join(", ")}.`,
      ],
    });

    const contabilidad = process.env.CONTABILIDAD_EMAIL?.trim();
    if (escaladas.length && contabilidad) {
      await sendOperationalEmail({
        to: contabilidad,
        subject: `KPS · escalamiento de ${escaladas.length} factura(s) con 48 h`,
        title: "Escalamiento por falta de liberación",
        paragraphs: [
          `${escaladas.length} factura(s) superaron 48 horas sin liberación.`,
          `Folios: ${escaladas.map((f) => `${f.folio} (${f.horasSinLiberar} h)`).join(", ")}.`,
        ],
      });
    }

    await AuditLog().create({
      entityType: "invoice-alert",
      entityId: new Date().toISOString(),
      action: "ALERTAS_LIBERACION_ENVIADAS",
      actorId: usuario.id,
      actorRole: usuario.role,
      before: null,
      after: { pendientes: pendientes.length, escaladas: escaladas.length },
      comment: escaladas.length && !contabilidad ? "Falta CONTABILIDAD_EMAIL; no se envió el escalamiento." : null,
      createdAt: new Date(),
    });
    return { pendientes: pendientes.length, escaladas: contabilidad ? escaladas.length : 0, bloqueos, faltaDestinoEscalamiento: escaladas.length > 0 && !contabilidad };
}

export async function POST() {
  try {
    const usuario = await requireModule("peticiones");
    return ok(await procesar(usuario));
  } catch (e) {
    return handleApiError(e);
  }
}

/** Entrada para un cron externo; Vercel envía el mismo secreto en Bearer. */
export async function GET(req: Request) {
  try {
    const secreto = process.env.CRON_SECRET?.trim();
    if (!secreto || req.headers.get("authorization") !== `Bearer ${secreto}`) {
      throw new ApiError(401, "NO_AUTORIZADO", "Credencial de tarea programada inválida.");
    }
    return ok(await procesar({ id: "sistema", role: "SINCRONIZACION" }));
  } catch (e) {
    return handleApiError(e);
  }
}
