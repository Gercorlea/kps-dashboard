import { ApiError } from "@/lib/api";
import { connectDB } from "@/lib/db";
import { RateLimit } from "@/models/RateLimit";

// Rate limiting con MongoDB + índice TTL (§5.6). Todos los límites viven
// aquí, en un solo lugar. Al superar el límite se responde 429 hasta que
// el registro expira solo.

const LIMITES = {
  login: { max: 8, ventanaSeg: 10 * 60 },
  refresh: { max: 60, ventanaSeg: 10 * 60 },
  recuperar: { max: 5, ventanaSeg: 15 * 60 },
  "carga-crear": { max: 20, ventanaSeg: 60 * 60 },
  "carga-procesar": { max: 10, ventanaSeg: 60 * 60 },
  chat: { max: 30, ventanaSeg: 5 * 60 },
} as const;

export type RateBucket = keyof typeof LIMITES;

export function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return "local";
}

export async function checkRateLimit(
  bucket: RateBucket,
  id: string
): Promise<{ permitido: boolean; reintentarEnSeg: number }> {
  await connectDB();
  const { max, ventanaSeg } = LIMITES[bucket];
  const key = `${bucket}:${id}`;
  const doc = await RateLimit.findOneAndUpdate(
    { key },
    {
      $inc: { hits: 1 },
      $setOnInsert: { expiresAt: new Date(Date.now() + ventanaSeg * 1000) },
    },
    { upsert: true, returnDocument: "after" }
  ).lean();
  const hits = doc?.hits ?? 1;
  const reintentarEnSeg = doc
    ? Math.max(1, Math.ceil((new Date(doc.expiresAt).getTime() - Date.now()) / 1000))
    : ventanaSeg;
  return { permitido: hits <= max, reintentarEnSeg };
}

export async function enforceRateLimit(bucket: RateBucket, id: string): Promise<void> {
  const { permitido, reintentarEnSeg } = await checkRateLimit(bucket, id);
  if (!permitido) {
    throw new ApiError(
      429,
      "RATE_LIMIT",
      `Demasiadas solicitudes. Intenta de nuevo en ${reintentarEnSeg} segundos.`,
      { reintentarEnSeg }
    );
  }
}
