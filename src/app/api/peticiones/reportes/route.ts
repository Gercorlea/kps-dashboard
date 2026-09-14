import { z } from "zod";
import { handleApiError, ok, parseQuery } from "@/lib/api";
import { requireModule } from "@/lib/auth/guards";
import { reporteFacturasProveedores } from "@/lib/proveedores/reportes";

export const runtime = "nodejs";

const Consulta = z.object({
  tipo: z.enum(["pendientes", "por-vencer", "vencidas"]).default("pendientes"),
});

export async function GET(req: Request) {
  try {
    await requireModule("peticiones");
    const { tipo } = parseQuery(req.url, Consulta);
    const facturas = await reporteFacturasProveedores(tipo);
    return ok({ tipo, total: facturas.length, facturas });
  } catch (e) {
    return handleApiError(e);
  }
}
