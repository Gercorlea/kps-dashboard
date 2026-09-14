import { ApiError, handleApiError, ok } from "@/lib/api";
import { requireModule } from "@/lib/auth/guards";
import { analizarSello } from "@/lib/proveedores/sello-ia";

export const runtime = "nodejs";
export const maxDuration = 120;

async function autorizar(req: Request) {
  const secreto = process.env.KPS_INTERNAL_API_SECRET?.trim();
  const bearer = req.headers.get("authorization");
  if (secreto && bearer === `Bearer ${secreto}`) return;
  await requireModule("peticiones");
}

export async function POST(req: Request, { params }: { params: Promise<{ folio: string }> }) {
  try {
    await autorizar(req);
    const { folio } = await params;
    try {
      return ok(await analizarSello(folio));
    } catch (e) {
      throw new ApiError(422, "SELLO_NO_ANALIZADO", e instanceof Error ? e.message : "No se pudo analizar el sello.");
    }
  } catch (e) {
    return handleApiError(e);
  }
}
