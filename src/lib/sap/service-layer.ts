// Cliente del Service Layer de SAP Business One (OData).
// Solo debe importarse desde código de servidor (route handlers, server components).

const SESSION_MARGIN_MS = 60_000

type SapSession = { cookie: string; expiresAt: number }

let session: SapSession | null = null
let loginPromise: Promise<SapSession> | null = null

export class SapError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string | number,
  ) {
    super(message)
    this.name = 'SapError'
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Falta la variable de entorno ${name} (ver .env.example)`)
  return value
}

function baseUrl(): string {
  return requiredEnv('SAP_SL_URL').replace(/\/+$/, '')
}

async function login(): Promise<SapSession> {
  const res = await fetch(`${baseUrl()}/Login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      CompanyDB: requiredEnv('SAP_SL_COMPANY_DB'),
      UserName: requiredEnv('SAP_SL_USERNAME'),
      Password: requiredEnv('SAP_SL_PASSWORD'),
    }),
    cache: 'no-store',
  })

  if (!res.ok) {
    throw new SapError(await readErrorMessage(res), res.status)
  }

  const cookie = res.headers
    .getSetCookie()
    .filter((c) => c.startsWith('B1SESSION') || c.startsWith('ROUTEID'))
    .map((c) => c.split(';')[0])
    .join('; ')

  if (!cookie) throw new SapError('Login OK pero SAP no devolvió cookie B1SESSION', res.status)

  const data = (await res.json()) as { SessionTimeout?: number }
  const timeoutMinutes = data.SessionTimeout ?? 30
  return { cookie, expiresAt: Date.now() + timeoutMinutes * 60_000 - SESSION_MARGIN_MS }
}

async function getSession(): Promise<SapSession> {
  if (session && Date.now() < session.expiresAt) return session
  loginPromise ??= login().finally(() => {
    loginPromise = null
  })
  session = await loginPromise
  return session
}

async function readErrorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as {
      error?: { code?: string | number; message?: { value?: string } | string }
    }
    const msg = body.error?.message
    const text = typeof msg === 'string' ? msg : msg?.value
    return text ?? `SAP Service Layer respondió ${res.status}`
  } catch {
    return `SAP Service Layer respondió ${res.status}`
  }
}

/**
 * Llama al Service Layer con sesión gestionada automáticamente.
 * Ejemplos: sapFetch('/Items?$select=ItemCode,ItemName&$top=5')
 *           sapFetch('/Orders', { method: 'POST', body: JSON.stringify(order) })
 */
export async function sapFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const doFetch = async (cookie: string) =>
    fetch(`${baseUrl()}${path.startsWith('/') ? path : `/${path}`}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...init.headers,
        Cookie: cookie,
      },
      cache: 'no-store',
    })

  let res = await doFetch((await getSession()).cookie)

  // Sesión caducada en SAP: reloguear una vez y reintentar.
  if (res.status === 401) {
    session = null
    res = await doFetch((await getSession()).cookie)
  }

  if (!res.ok) {
    throw new SapError(await readErrorMessage(res), res.status)
  }

  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

/** Fuerza un Login nuevo contra SAP y confirma que la sesión abre (sin consultar datos). */
export async function sapCheckConnection(): Promise<void> {
  session = null
  await getSession()
}
