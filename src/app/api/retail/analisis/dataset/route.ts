import { gzipSync } from "node:zlib";
import type { NextRequest } from "next/server";
import { handleApiError, ok, parseQuery } from "@/lib/api";
import { requireModule } from "@/lib/auth/guards";
import { connectDB } from "@/lib/db";
import { datasetAnalisisQuerySchema, MAX_FILAS_DATASET } from "@/lib/validation/retail";
import { SalesReport } from "@/models/SalesReport";

/**
 * Campos que viajan, en el orden en que se arma cada fila.
 *
 * Las filas van como ARREGLOS y no como objetos: repetir catorce nombres de
 * campo en quince mil filas duplica el tamaño de la respuesta (4.5 MB contra
 * 2.0 MB en crudo) sin aportar nada, porque el cliente ya sabe qué columna es
 * cada posición — se la decimos aquí abajo, en `campos`.
 */
const CAMPOS = [
  "brand",
  "primeItemNbr",
  "itemDesc",
  "upc",
  "productCode",
  "wmMonth",
  "posQty",
  "posSales",
  "avgPrice",
  "avgSalesPerStore",
  "itemQtySold",
  "basketOccurrences",
  "date",
  "itemNbr",
] as const;

const PROYECCION = Object.fromEntries(CAMPOS.map((c) => [c, 1]));

/** Las fechas se guardan a medianoche UTC; se devuelven como "2024-07-06". */
function fechaISO(d: unknown): string {
  return d instanceof Date ? d.toISOString().slice(0, 10) : "";
}

/**
 * Igual que `ok()`, pero comprimido.
 *
 * Next NO comprime la respuesta de un route handler — ni con `next start` —, y
 * este cuerpo son 2 MB de JSON con muchísima repetición que bajan a unos 300 KB.
 * Comprimir cuesta ~60 ms de CPU y ahorra ~1.8 MB de red en cada entrada a la
 * pestaña, así que sale a cuenta con holgura. El navegador descomprime solo al
 * ver `content-encoding`; aun así se respeta `accept-encoding` por si el
 * llamador no lo soporta.
 */
function okComprimido(request: NextRequest, data: unknown): Response {
  const cuerpo = JSON.stringify({ ok: true, data });
  if (!(request.headers.get("accept-encoding") ?? "").includes("gzip")) {
    return new Response(cuerpo, {
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
  // Nivel 6 (el de por omisión): con este JSON, subir a 9 gana ~2% de tamaño
  // y cuesta varias veces más CPU.
  const gz = gzipSync(cuerpo, { level: 6 });
  return new Response(new Uint8Array(gz), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-encoding": "gzip",
      "content-length": String(gz.length),
      vary: "Accept-Encoding",
    },
  });
}

// GET /api/retail/analisis/dataset — el último reporte guardado, completo.
//
// Sin `sourceFile` devuelve el del Excel más reciente, que es lo que se muestra
// al entrar a /retail/analisis. Se manda entero, y no paginado, porque los
// filtros y las gráficas necesitan TODAS las filas para agregar: bajarlo una
// vez y agregar en el navegador reusa exactamente el mismo código que un
// archivo recién subido, en vez de reimplementar en Mongo el top-N, el "Otros"
// ponderado y el relleno de huecos de la serie temporal.
export async function GET(request: NextRequest) {
  try {
    await requireModule("retail");
    const q = parseQuery(request.url, datasetAnalisisQuerySchema);
    await connectDB();

    // Qué archivo se está viendo. El más reciente por importedAt cuando no se
    // pide uno, para que "el último cargado" no dependa del orden de inserción.
    const ultimo = await SalesReport.findOne(
      q.sourceFile
        ? { sourceFile: q.sourceFile, ...(q.account ? { account: q.account } : {}) }
        : q.account
          ? { account: q.account }
          : {}
    )
      .sort(q.sourceFile ? { date: 1 } : { importedAt: -1 })
      .select({ sourceFile: 1, template: 1, account: 1, importedAt: 1 })
      .lean();

    // Retailers que TIENEN reportes guardados. Se mandan para que el selector
    // de la vista ofrezca sólo esos: listar los cuatro llevaría a elegir uno
    // vacío y toparse con un "sin datos" que no explica nada.
    const cuentas = (await SalesReport.distinct("account")) as string[];

    if (!ultimo) {
      return ok({ archivo: null, cuentas, campos: CAMPOS, filas: [], truncado: false });
    }

    const filtro = { account: ultimo.account, sourceFile: ultimo.sourceFile };
    const total = await SalesReport.countDocuments(filtro);

    const docs = await SalesReport.find(filtro)
      // Mismo orden que la clave natural del grano, para que la tabla salga
      // estable entre cargas.
      .sort({ date: 1, itemNbr: 1 })
      .limit(MAX_FILAS_DATASET)
      .select(PROYECCION)
      .lean();

    return okComprimido(request, {
      archivo: {
        sourceFile: ultimo.sourceFile,
        template: ultimo.template,
        account: ultimo.account,
        importedAt: ultimo.importedAt?.toISOString() ?? null,
        total,
      },
      cuentas,
      campos: CAMPOS,
      filas: docs.map((d) => {
        const doc = d as unknown as Record<string, unknown>;
        return CAMPOS.map((c) => (c === "date" ? fechaISO(doc[c]) : (doc[c] ?? null)));
      }),
      truncado: total > docs.length,
    });
  } catch (e) {
    return handleApiError(e);
  }
}
