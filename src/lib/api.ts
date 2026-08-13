import { NextResponse } from "next/server";
import type { ZodType } from "zod";

// Contrato único de respuesta (§3):
//   éxito → { ok: true, data: T }
//   error → { ok: false, error: { code, message, details? } }

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown
  ) {
    super(message);
  }
}

export function ok<T>(data: T, init?: ResponseInit) {
  return NextResponse.json({ ok: true, data }, init);
}

export function fail(status: number, code: string, message: string, details?: unknown) {
  return NextResponse.json(
    {
      ok: false,
      error: { code, message, ...(details !== undefined ? { details } : {}) },
    },
    { status }
  );
}

// Nunca filtrar stack traces ni mensajes internos al cliente (§3).
export function handleApiError(e: unknown) {
  if (e instanceof ApiError) return fail(e.status, e.code, e.message, e.details);
  console.error("[api]", e);
  return fail(500, "INTERNO", "Error interno del servidor");
}

export async function parseJson<T>(req: Request, schema: ZodType<T>): Promise<T> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new ApiError(422, "JSON_INVALIDO", "El cuerpo debe ser JSON válido");
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(422, "VALIDACION", "Datos inválidos", parsed.error.flatten());
  }
  return parsed.data;
}

export function parseQuery<T>(url: string, schema: ZodType<T>): T {
  const params = Object.fromEntries(new URL(url).searchParams.entries());
  const parsed = schema.safeParse(params);
  if (!parsed.success) {
    throw new ApiError(422, "VALIDACION", "Parámetros inválidos", parsed.error.flatten());
  }
  return parsed.data;
}
