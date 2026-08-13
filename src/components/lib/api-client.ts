"use client";

// Cliente del contrato de API (§3): { ok, data } | { ok, error }.
// En 401 intenta un refresh (rotación §5.1) y reintenta una vez.

export class ClientApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown
  ) {
    super(message);
  }
}

type Envelope<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; details?: unknown } };

async function llamar(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, {
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
}

export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  let res = await llamar(url, init);

  if (res.status === 401 && !url.startsWith("/api/auth/")) {
    const refresh = await fetch("/api/auth/refresh", { method: "POST" });
    if (refresh.ok) {
      res = await llamar(url, init);
    } else {
      window.location.href = "/login";
      throw new ClientApiError(401, "NO_AUTENTICADO", "Sesión expirada");
    }
  }

  let cuerpo: Envelope<T>;
  try {
    cuerpo = (await res.json()) as Envelope<T>;
  } catch {
    throw new ClientApiError(res.status, "RESPUESTA", "Respuesta inválida del servidor");
  }
  if (!cuerpo.ok) {
    throw new ClientApiError(
      res.status,
      cuerpo.error.code,
      cuerpo.error.message,
      cuerpo.error.details
    );
  }
  return cuerpo.data;
}
