import { Types } from "mongoose";
import type { NextRequest } from "next/server";
import { handleApiError, ok, parseJson, parseQuery } from "@/lib/api";
import { requireModule } from "@/lib/auth/guards";
import { connectDB } from "@/lib/db";
import { invalidarRetail } from "@/lib/retail/cache";
import { PRIMERA_ESCRITURA, ULTIMA_ACTUALIZACION } from "@/lib/retail/importaciones";
import { usuariosPorId } from "@/lib/usuarios";
import { guardarAnalisisSchema, historicoAnalisisQuerySchema } from "@/lib/validation/retail";
import { SalesReport } from "@/models/SalesReport";

/** "2024-07-06" → medianoche UTC, como el resto de retail (fechaISO). */
function fechaUTC(iso: string): Date {
  const [a, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(a, m - 1, d));
}

/**
 * Cuántas órdenes de escritura salen en paralelo por cada lote recibido.
 *
 * Medido contra el clúster real con las 15,344 filas del reporte de Walmart,
 * mandando los mismos lotes de 2000 filas que manda el cliente:
 *
 *   1 orden de 2000 …… 114 s      8 órdenes de 250 …… 19 s
 *   4 órdenes de 500 …  33 s     16 órdenes de 125 …… 13 s
 *
 * El cuello no son los bytes ni la replicación —comprimir el lote 19× con zlib
 * dio 114 s igual, y `w: 1` también—: es la latencia de cada upsert contra un
 * clúster compartido, y lo único que la tapa es tener varias órdenes en vuelo.
 *
 * Se queda en 8 y no en 16 porque de ahí en adelante la curva se aplana (32
 * órdenes dieron 12 s) y cada orden es una conexión más al clúster, con varias
 * cargas simultáneas y varias instancias del servidor de por medio.
 */
const ORDENES_EN_PARALELO = 8;

/**
 * Filas del lote sin claves repetidas, quedándose con la ÚLTIMA.
 *
 * Es lo que hacía una sola orden con las 2000 filas: aplicaba las operaciones
 * en fila y la última ganaba. Al repartir el lote en órdenes paralelas, dos
 * filas con la misma clave natural podrían intentar insertarse a la vez y una
 * moriría con E11000, así que se resuelve antes de escribir. El reporte no
 * debería traerlas —(itemNbr, date) es única en su grano—, pero el guardado no
 * puede depender de eso.
 */
function sinClavesRepetidas<T extends { itemNbr: number; date: string }>(filas: T[]): T[] {
  const porClave = new Map<string, T>();
  for (const f of filas) porClave.set(`${f.itemNbr}|${f.date}`, f);
  return [...porClave.values()];
}

/** Una fila por reporte guardado: el $group de abajo, antes de resolver autores. */
interface ArchivoAgrupado {
  _id: string;
  filas: number;
  importado: Date | null;
  /** Null si el reporte no se ha vuelto a subir desde que se importó. */
  actualizado: Date | null;
  subidoPor: Types.ObjectId | null;
}

// POST /api/retail/analisis — guarda un lote de filas en el histórico.
//
// Upsert por la clave natural (account, itemNbr, date): volver a subir el mismo
// reporte actualiza en vez de duplicar, que es lo que mantiene sano un
// histórico al que se le carga el mismo mes dos veces.
export async function POST(request: NextRequest) {
  try {
    const usuario = await requireModule("retail");
    const { template, account, sourceFile, filas } = await parseJson(
      request,
      guardarAnalisisSchema
    );
    await connectDB();

    const importedAt = new Date();
    const importedBy = new Types.ObjectId(usuario.id);

    // Rescate de las filas guardadas antes de que existiera `firstImportedAt`:
    // se les copia el `importedAt` que traen ANTES de que el lote se lo pise,
    // que es la única fecha de importación que quedaba de ellas.
    //
    // Va en una orden aparte y no dentro del upsert de cada fila a propósito.
    // La primera versión resolvía esto con un update de pipeline por fila
    // (`$ifNull: ["$firstImportedAt", "$importedAt", …]`), y se midió: el
    // pipeline obliga a envolver cada valor en `$literal` —un texto que empieza
    // por "$" se leería como referencia a un campo— y eso infla el comando un
    // 46% (1,463 → 2,143 KB por lote de 2000 filas). Con el enlace a la base a
    // ~110 KB/s eso son 8 segundos más POR LOTE: la carga de 15 mil filas pasó
    // de 80 a 150 segundos. Así el lote vuelve a viajar con operadores y el
    // rescate cuesta una sola orden pequeña (~200 ms, y cero filas tocadas en
    // cuanto la cuenta está al día).
    //
    // `updatePipeline: true` es obligatorio en esta versión de Mongoose para
    // pasar un pipeline a un update: avisa de que no va a castear los valores.
    // Aquí no hay nada que castear —los dos campos se copian de la propia fila—.
    await SalesReport.updateMany(
      { account, firstImportedAt: { $exists: false } },
      [{ $set: { firstImportedAt: "$importedAt", firstImportedBy: "$importedBy" } }],
      { updatePipeline: true }
    );

    const operacion = (f: (typeof filas)[number]) => {
      const { date, ...resto } = f;
      const fecha = fechaUTC(date);
      return {
        updateOne: {
          filter: { account, itemNbr: f.itemNbr, date: fecha },
          update: {
            $set: {
              ...resto,
              date: fecha,
              template,
              account,
              sourceFile,
              importedAt,
              importedBy,
            },
            // La primera escritura no se toca al volver a subir el reporte: es
            // lo que separa "importado el" de "última actualización" en la
            // ficha del retailer. Una fila con importedAt > firstImportedAt es,
            // exactamente, una fila que reescribió una carga posterior.
            //
            // Sólo cubre las ALTAS; de las filas viejas que no traen el campo
            // se encarga el rescate de arriba, antes de que este $set les pise
            // el importedAt.
            $setOnInsert: { firstImportedAt: importedAt, firstImportedBy: importedBy },
          },
          upsert: true,
        },
      };
    };

    // El lote se reparte en varias órdenes que viajan a la vez (ver
    // ORDENES_EN_PARALELO). Son disjuntas por construcción —cada fila cae en
    // una sola— así que el resultado es el mismo que escribirlas en fila.
    const unicas = sinClavesRepetidas(filas);
    const porOrden = Math.ceil(unicas.length / ORDENES_EN_PARALELO);
    const ordenes: (typeof filas)[] = [];
    for (let i = 0; i < unicas.length; i += porOrden) {
      ordenes.push(unicas.slice(i, i + porOrden));
    }

    const res = await Promise.all(
      ordenes.map((orden) =>
        SalesReport.bulkWrite(orden.map(operacion), { ordered: false })
      )
    );
    // El histórico cambió: los agregados guardados en memoria ya no lo
    // describen. Se tiran aquí y no en el siguiente GET porque una carga se
    // sube en lotes y el usuario abre su ficha en cuanto termina el último.
    invalidarRetail();

    return ok({
      recibidas: filas.length,
      insertadas: res.reduce((n, r) => n + r.upsertedCount, 0),
      actualizadas: res.reduce((n, r) => n + r.modifiedCount, 0),
    });
  } catch (e) {
    return handleApiError(e);
  }
}

// GET /api/retail/analisis — resumen del histórico, para saber qué hay guardado.
export async function GET(request: NextRequest) {
  try {
    await requireModule("retail");
    const { account } = parseQuery(request.url, historicoAnalisisQuerySchema);
    await connectDB();

    const filtro = account ? { account } : {};
    const total = await SalesReport.countDocuments(filtro);
    if (total === 0) return ok({ total: 0, desde: null, hasta: null, archivos: [] });

    const [rango] = await SalesReport.aggregate<{ desde: Date; hasta: Date }>([
      { $match: filtro },
      { $group: { _id: null, desde: { $min: "$date" }, hasta: { $max: "$date" } } },
    ]);

    const archivos = await SalesReport.aggregate<ArchivoAgrupado>([
      { $match: filtro },
      // Proyectar antes de ordenar: el $sort de abajo es en memoria y no tiene
      // por qué arrastrar las métricas de cada fila.
      {
        $project: {
          sourceFile: 1,
          importedAt: 1,
          ...PRIMERA_ESCRITURA,
        },
      },
      // Ordenar por la primera escritura es lo que le da sentido al $first de
      // `subidoPor`: la fila más antigua del archivo es la de la carga original.
      { $sort: { primerImport: 1 } },
      {
        $group: {
          _id: "$sourceFile",
          filas: { $sum: 1 },
          importado: { $min: "$primerImport" },
          actualizado: ULTIMA_ACTUALIZACION,
          subidoPor: { $first: "$primerAutor" },
          // Sólo para ordenar la lista: el reporte tocado más recientemente va
          // primero, igual que antes de que existiera la columna de importado.
          ultimaEscritura: { $max: "$importedAt" },
        },
      },
      { $sort: { ultimaEscritura: -1 } },
      { $limit: 20 },
    ]);

    const autores = await usuariosPorId(archivos.map((a) => a.subidoPor));

    return ok({
      total,
      desde: rango?.desde?.toISOString().slice(0, 10) ?? null,
      hasta: rango?.hasta?.toISOString().slice(0, 10) ?? null,
      archivos: archivos.map((a) => ({
        sourceFile: a._id,
        filas: a.filas,
        importado: a.importado?.toISOString() ?? null,
        actualizado: a.actualizado?.toISOString() ?? null,
        subidoPor: autores.get(String(a.subidoPor)) ?? null,
      })),
    });
  } catch (e) {
    return handleApiError(e);
  }
}
