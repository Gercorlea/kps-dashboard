import type { NextRequest } from "next/server";
import { handleApiError, ok, parseQuery } from "@/lib/api";
import { requireModule } from "@/lib/auth/guards";
import { serieHistorica } from "@/lib/retail/stats";
import { historicoQuerySchema } from "@/lib/validation/retail";

export async function GET(request: NextRequest) {
  try {
    await requireModule("retail");
    const q = parseQuery(request.url, historicoQuerySchema);
    const serie = await serieHistorica(q.account, q.desde, q.hasta);
    return ok(serie);
  } catch (e) {
    return handleApiError(e);
  }
}
