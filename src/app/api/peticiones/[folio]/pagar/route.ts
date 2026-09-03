import { ApiError, handleApiError, ok } from "@/lib/api";
import { requireModule } from "@/lib/auth/guards";
import { PagoSimuladoError, simularPago } from "@/lib/proveedores/simular-pago";
import { sincronizarPagos } from "@/lib/proveedores/sincronizar-pagos";

/**
 * POST /api/peticiones/[folio]/pagar — HERRAMIENTA DE PRUEBAS.
 *
 * Crea el pago de la factura en Business One y acto seguido sincroniza, para que
 * el portal la vea como pagada sin tener que lanzar dos llamadas.
 *
 * NO ES TESORERIA. El pago real lo hace tesoreria dentro de B1, donde viven las
 * autorizaciones, la conciliacion bancaria y la segregacion de funciones. Esto
 * existe solo para poder recorrer el ciclo completo en pruebas sin depender de
 * alguien con acceso a Business One, y va apagado salvo que
 * `FEATURE_PAGO_SIMULADO=true`.
 *
 * La sincronizacion se acota al folio pagado: no hay motivo para revisar toda la
 * bandeja porque se pago una factura.
 */
export const runtime = "nodejs";

export async function POST(_req: Request, { params }: { params: Promise<{ folio: string }> }) {
  try {
    const usuario = await requireModule("peticiones");
    const { folio } = await params;

    const pago = await simularPago({ folio, actorId: usuario.id, actorRole: usuario.role });

    // Si el pago entro pero la sincronizacion falla, el pago SIGUE HECHO: se
    // reporta y ya, en vez de presentarlo como que no se pago. La proxima
    // sincronizacion lo recoge.
    let sincronizado = null;
    let avisoSync: string | null = null;
    try {
      sincronizado = await sincronizarPagos({
        folios: [folio],
        actorId: usuario.id,
        actorRole: usuario.role,
      });
    } catch (e) {
      avisoSync = e instanceof Error ? e.message : "No se pudo sincronizar tras el pago.";
    }

    return ok({ folio, pago, sincronizado, avisoSync });
  } catch (e) {
    if (e instanceof PagoSimuladoError) {
      // Se traduce a ApiError para que salga con el mismo formato que el resto
      // de errores del dashboard, en vez de un 200 con `ok: false` que el
      // cliente tendria que inspeccionar aparte.
      const status = e.motivo === "DESHABILITADO" ? 403 : 422;
      return handleApiError(new ApiError(status, e.motivo, e.message));
    }
    return handleApiError(e);
  }
}
