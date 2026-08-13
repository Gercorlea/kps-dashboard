import type { NextRequest } from "next/server";
import { handleApiError, ok, parseQuery } from "@/lib/api";
import { requireModule } from "@/lib/auth/guards";
import { connectDB } from "@/lib/db";
import { patronSinAcentos } from "@/lib/retail/analisis/filtrar";
import { filasAnalisisQuerySchema } from "@/lib/validation/retail";
import { ReporteVenta } from "@/models/ReporteVenta";

/** Las fechas se guardan a medianoche UTC; se devuelven como "2024-07-06". */
function fechaISO(d: Date | null | undefined): string {
  return d instanceof Date ? d.toISOString().slice(0, 10) : "";
}

// GET /api/retail/analisis/filas — filas del histórico, paginadas.
//
// Sin `sourceFile` devuelve las del ÚLTIMO Excel cargado, que es lo que se
// muestra al entrar a /retail/analisis. Se pagina en el servidor: bajar las 15
// mil filas del reporte sólo para abrir la pestaña serían varios MB por
// navegación, y ya existe el flujo de subir el archivo para analizarlo entero.
export async function GET(request: NextRequest) {
  try {
    await requireModule("retail");
    const q = parseQuery(request.url, filasAnalisisQuerySchema);
    await connectDB();

    // Qué archivo se está viendo. El más reciente por importedAt cuando no se
    // pide uno, para que "el último cargado" no dependa del orden de inserción.
    const ultimo = await ReporteVenta.findOne(
      q.sourceFile
        ? { sourceFile: q.sourceFile, ...(q.account ? { account: q.account } : {}) }
        : q.account
          ? { account: q.account }
          : {}
    )
      .sort(q.sourceFile ? { date: 1 } : { importedAt: -1 })
      .select({ sourceFile: 1, plantilla: 1, account: 1, importedAt: 1 })
      .lean();

    if (!ultimo) {
      return ok({ archivo: null, filas: [], total: 0, pagina: 1, paginas: 1 });
    }

    const base = { account: ultimo.account, sourceFile: ultimo.sourceFile };
    const filtro: Record<string, unknown> = { ...base };

    // Buscador de producto: descripción, marca y códigos. Se incluye itemNbr
    // sólo si lo tecleado es un número, si no la comparación nunca calzaría.
    if (q.buscar) {
      const rx = { $regex: patronSinAcentos(q.buscar), $options: "i" };
      const o: Record<string, unknown>[] = [
        { itemDesc: rx },
        { brand: rx },
        { upc: rx },
        { productCode: rx },
      ];
      const n = Number(q.buscar);
      if (Number.isInteger(n)) o.push({ itemNbr: n }, { primeItemNbr: n });
      filtro.$or = o;
    }

    const [total, totalArchivo] = await Promise.all([
      ReporteVenta.countDocuments(filtro),
      q.buscar ? ReporteVenta.countDocuments(base) : Promise.resolve(0),
    ]);

    const docs = await ReporteVenta.find(filtro)
      // Orden total: (date, itemNbr) es la clave natural del grano, así que no
      // hay empates y una fila no puede aparecer en dos páginas.
      .sort({ date: 1, itemNbr: 1 })
      .skip((q.page - 1) * q.limit)
      .limit(q.limit)
      .select({ plantilla: 0, account: 0, sourceFile: 0, importedAt: 0, importedBy: 0 })
      .lean();

    return ok({
      archivo: {
        sourceFile: ultimo.sourceFile,
        plantilla: ultimo.plantilla,
        account: ultimo.account,
        importedAt: ultimo.importedAt?.toISOString() ?? null,
        total: q.buscar ? totalArchivo : total,
      },
      filas: docs.map((d) => ({
        ...d,
        _id: String(d._id),
        date: fechaISO(d.date),
      })),
      total,
      pagina: q.page,
      paginas: Math.max(1, Math.ceil(total / q.limit)),
    });
  } catch (e) {
    return handleApiError(e);
  }
}
