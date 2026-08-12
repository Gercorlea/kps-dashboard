import { sapCheckConnection, SapError } from '@/lib/sap/service-layer'

// GET /api/sap/ping — solo hace Login y responde si la conexión a SAP funciona.
export async function GET() {
  try {
    await sapCheckConnection()
    return Response.json({ ok: true, mensaje: 'Conectado a SAP' })
  } catch (error) {
    const status = error instanceof SapError ? error.status : 500
    const message = error instanceof Error ? error.message : 'Error desconocido'
   
    const causas: string[] = []
    let cause: unknown = error instanceof Error ? error.cause : undefined
    while (cause instanceof Error) {
      const code = 'code' in cause && cause.code ? ` [${String(cause.code)}]` : ''
      causas.push(`${cause.message}${code}`)
      cause = cause.cause
    }
    return Response.json(
      { ok: false, error: message, causa: causas.length ? causas : undefined },
      { status: status >= 400 ? 502 : 500 },
    )
  }
}
