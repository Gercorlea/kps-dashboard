import { handleApiError } from "@/lib/api";
import { requireUser } from "@/lib/auth/guards";
// Misma tabla de campos que usa KPS AI: una sola fuente, sin desincronizarse.
import { camposPorDefecto } from "@/lib/sap/campos";
import { SapError, sapFetch } from "@/lib/sap/service-layer";

// Pasarela de SOLO LECTURA al Service Layer: una sola ruta para todas las
// entidades de SAP, en vez de un route.ts por cada una.
//
//   GET /api/sap                       → índice de entidades disponibles
//   GET /api/sap/Items?$top=5          → cualquier entity set
//   GET /api/sap/Items('70006147')     → un documento por clave
//   GET /api/sap/Orders?$filter=DocStatus eq 'O'&$select=DocNum,CardName
//
// Solo se exporta GET: POST/PATCH/DELETE responden 405 por sí solos, así que
// esta ruta no puede escribir en SAP ni por error.

const TOP_MAX = 100;
const TOP_DEFECTO = 20;

// Login/Logout manipulan la sesión que sapFetch cachea; dejarlas pasar
// rompería la sesión compartida del proceso.
const PROHIBIDAS = new Set(["login", "logout"]);

// Respaldo para entidades sin campos por defecto: al menos quitar los arrays
// anidados, que son los que disparan el tamaño de la respuesta.
function sinColecciones(data: unknown): { limpio: unknown; omitidas: string[] } {
  const omitidas = new Set<string>();
  const podar = (row: unknown): unknown => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return row;
    const salida: Record<string, unknown> = {};
    for (const [clave, value] of Object.entries(row)) {
      if (Array.isArray(value)) omitidas.add(clave);
      else salida[clave] = value;
    }
    return salida;
  };

  const cuerpo = data as { value?: unknown } | null;
  if (cuerpo && typeof cuerpo === "object" && Array.isArray(cuerpo.value)) {
    return { limpio: { ...cuerpo, value: cuerpo.value.map(podar) }, omitidas: [...omitidas] };
  }
  return { limpio: podar(data), omitidas: [...omitidas] };
}

export async function GET(request: Request, ctx: { params: Promise<{ ruta?: string[] }> }) {
  try {
    // /api/sap está fuera del matcher de proxy.ts, así que la sesión se
    // valida aquí. Cambia a requireSuperadmin() si quieres restringirlo más.
    await requireUser();

    const { ruta = [] } = await ctx.params;

    if (ruta.some((s) => s.includes("..") || s.startsWith("/"))) {
      return Response.json({ ok: false, error: "Ruta no válida" }, { status: 400 });
    }
    if (ruta.length && PROHIBIDAS.has(ruta[0].toLowerCase())) {
      return Response.json(
        {
          ok: false,
          error: `${ruta[0]} no se puede llamar desde aquí: la sesión la gestiona sapFetch`,
        },
        { status: 403 }
      );
    }

    // El query string pasa íntegro ($filter, $select, $orderby, $expand,
    // $skip…), acotando solo $top para no traer medio ERP en una respuesta.
    const params = new URLSearchParams(new URL(request.url).search);

    // ?crudo devuelve la respuesta de SAP intacta. Si el usuario ya eligió
    // campos con $select o pidió anidados con $expand, tampoco se poda.
    const crudo = params.has("crudo") || params.has("$select") || params.has("$expand");
    params.delete("crudo"); // no es OData: no debe llegar a SAP

    // Sin $select propio, pedimos solo los campos clave de la entidad.
    const porDefecto = crudo ? undefined : camposPorDefecto(ruta[0] ?? "");
    if (porDefecto) params.set("$select", porDefecto);

    const pedido = Number(params.get("$top"));
    const top = Number.isFinite(pedido) && pedido > 0 ? Math.min(pedido, TOP_MAX) : TOP_DEFECTO;
    params.set("$top", String(top));

    const path = ruta.length ? `/${ruta.join("/")}` : "/";
    // El Service Layer pagina de 20 en 20 (PageSize de b1s.conf) y devuelve
    // odata.nextLink; sin esta cabecera un $top=50 solo trae 20 filas.
    const data = await sapFetch<unknown>(`${path}?${params}`, {
      headers: { Prefer: `odata.maxpagesize=${top}` },
    });
    if (crudo) return Response.json(data);

    if (porDefecto) {
      return Response.json(data, {
        headers: { "X-Campos-Por-Defecto": porDefecto, "X-Ver-Todo": "anade ?crudo" },
      });
    }

    // Entidad sin lista de campos clave: al menos sin colecciones anidadas.
    const { limpio, omitidas } = sinColecciones(data);
    return Response.json(limpio, {
      headers: omitidas.length
        ? { "X-Colecciones-Omitidas": omitidas.join(","), "X-Ver-Todo": "anade ?crudo" }
        : undefined,
    });
  } catch (e) {
    if (e instanceof SapError) {
      return Response.json(
        { ok: false, error: e.message, code: e.code, statusSap: e.status },
        { status: e.status >= 400 && e.status < 500 ? e.status : 502 }
      );
    }
    return handleApiError(e);
  }
}
