import type { NextRequest } from "next/server";
import { handleApiError, ok, parseQuery } from "@/lib/api";
import { requireModule } from "@/lib/auth/guards";
import { connectDB } from "@/lib/db";
import { patronSinAcentos } from "@/lib/retail/analisis/filtrar";
import { plantillaPorId, seleccionHistorico } from "@/lib/retail/analisis/plantillas";
import { filasAnalisisQuerySchema } from "@/lib/validation/retail";
import { SalesReport } from "@/models/SalesReport";

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
//
// Las filas viajan como ARREGLOS en el orden que dice `campos`, no como objetos:
// es la forma que consume `datasetDesdeHistorico`, así que el cliente arma con
// ellas el mismo Dataset que un archivo recién subido y la tabla, el formateo de
// celdas y el buscador siguen siendo el mismo código en los dos modos.
export async function GET(request: NextRequest) {
  try {
    await requireModule("retail");
    const q = parseQuery(request.url, filasAnalisisQuerySchema);
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

    const plantilla = ultimo ? plantillaPorId(ultimo.template) : null;
    if (!ultimo || !plantilla) {
      return ok({ archivo: null, campos: [], filas: [], total: 0, pagina: 1, paginas: 1 });
    }

    // El orden de los campos lo manda la plantilla, que es también de donde el
    // cliente saca las columnas: así las dos listas no se pueden desalinear.
    const campos = seleccionHistorico(plantilla).columnas.map((c) => c.campo);

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
      SalesReport.countDocuments(filtro),
      q.buscar ? SalesReport.countDocuments(base) : Promise.resolve(0),
    ]);

    const docs = await SalesReport.find(filtro)
      // Orden total: (date, itemNbr) es la clave natural del grano, así que no
      // hay empates y una fila no puede aparecer en dos páginas.
      .sort({ date: 1, itemNbr: 1 })
      .skip((q.page - 1) * q.limit)
      .limit(q.limit)
      .select(Object.fromEntries(campos.map((c) => [c, 1])))
      .lean();

    return ok({
      archivo: {
        sourceFile: ultimo.sourceFile,
        template: ultimo.template,
        account: ultimo.account,
        importedAt: ultimo.importedAt?.toISOString() ?? null,
        total: q.buscar ? totalArchivo : total,
      },
      campos,
      filas: docs.map((d) => {
        const doc = d as unknown as Record<string, unknown>;
        return campos.map((c) => (c === "date" ? fechaISO(d.date) : (doc[c] ?? null)));
      }),
      total,
      pagina: q.page,
      paginas: Math.max(1, Math.ceil(total / q.limit)),
    });
  } catch (e) {
    return handleApiError(e);
  }
}
