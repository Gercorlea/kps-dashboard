import type { NextRequest } from "next/server";
import { handleApiError, ok, parseQuery } from "@/lib/api";
import { requireModule } from "@/lib/auth/guards";
import { generarScorecard } from "@/lib/retail/scorecard";
import { scorecardQuerySchema } from "@/lib/validation/retail";

// Scorecard calculado desde las colecciones persistidas (§8), nunca desde
// un archivo. GET /api/retail/scorecard?cuenta=san-pablo&hasta=YYYY-MM-DD
export async function GET(request: NextRequest) {
  try {
    await requireModule("retail");
    const q = parseQuery(request.url, scorecardQuerySchema);
    const scorecard = await generarScorecard(q.cuenta, q.hasta);
    return ok(scorecard);
  } catch (e) {
    return handleApiError(e);
  }
}
