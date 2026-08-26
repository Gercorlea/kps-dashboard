import { ApiError, handleApiError, ok } from "@/lib/api";
import { requireModule } from "@/lib/auth/guards";
import { sincronizarPagos } from "@/lib/proveedores/sincronizar-pagos";

/**
 * POST /api/peticiones/sincronizar-pagos
 *
 * Pregunta a Business One que facturas ya se pagaron y lo refleja en el portal.
 *
 * POR QUE ES UNA RUTA Y NO ALGO AUTOMATICO. Lo correcto seria un worker de cola
 * corriendo cada cierto tiempo (§04 principio 2), pero no hay ninguno en el
 * proyecto todavia. Mientras tanto esto se puede llamar desde la bandeja, o
 * engancharse a un cron externo: la funcion es la misma y no cambiara cuando
 * exista la cola.
 *
 * ES SOLO LECTURA CONTRA SAP. No escribe nada en Business One; solo consulta y
 * actualiza el documento local. Repetirlo no tiene efecto acumulativo: una
 * factura ya marcada como pagada no vuelve a entrar.
 *
 * Acepta `{ folios: ["FAC-2026-007"] }` para sincronizar unas concretas. Sin
 * cuerpo, revisa todas las registradas que aun no constan pagadas.
 */
export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const usuario = await requireModule("proveedores");

    // El cuerpo es opcional: un POST sin nada es "sincroniza todo". Un JSON
    // malformado se trata como ausente y no como error, porque la llamada
    // habitual —desde un boton— no manda cuerpo.
    let folios: string[] | undefined;
    try {
      const cuerpo = (await req.json()) as { folios?: unknown };
      if (Array.isArray(cuerpo?.folios)) {
        folios = cuerpo.folios.filter((f): f is string => typeof f === "string");
      }
    } catch {
      folios = undefined;
    }

    if (folios && folios.length > 100) {
      throw new ApiError(422, "DEMASIADOS", "Manda como mucho 100 folios por llamada.");
    }

    const resumen = await sincronizarPagos({
      folios,
      actorId: usuario.id,
      actorRole: usuario.role,
    });

    return ok(resumen);
  } catch (e) {
    return handleApiError(e);
  }
}
