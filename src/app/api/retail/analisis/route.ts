import { Types } from "mongoose";
import type { NextRequest } from "next/server";
import { handleApiError, ok, parseJson, parseQuery } from "@/lib/api";
import { requireModule } from "@/lib/auth/guards";
import { connectDB } from "@/lib/db";
import { invalidarRetail } from "@/lib/retail/cache";
import {
  operacionDeFila,
  pipelineFilasPorArchivo,
  reportesListados,
} from "@/lib/retail/importaciones";
import { usuariosPorId } from "@/lib/usuarios";
import { guardarAnalisisSchema, historicoAnalisisQuerySchema } from "@/lib/validation/retail";
import { ReportImport } from "@/models/ReportImport";
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
 * filas con la misma clave podrían caer en órdenes distintas y chocar.
 */
function sinClavesRepetidas<T extends { itemNbr: number; date: string }>(filas: T[]): T[] {
  const porClave = new Map<string, T>();
  for (const f of filas) porClave.set(`${f.itemNbr}|${f.date}`, f);
  return [...porClave.values()];
}

/** Cuántos reportes lista la ficha del retailer. */
const MAX_REPORTES = 20;

/** Índice único violado: el documento ya existe, que es lo que se quería. */
function esClaveDuplicada(e: unknown): boolean {
  return (e as { code?: number })?.code === 11000;
}

// POST /api/retail/analisis — guarda un lote de filas en el histórico.
//
// Upsert por la clave natural (account, itemNbr, date): volver a subir el mismo
// reporte actualiza en vez de duplicar, que es lo que mantiene sano un
// histórico al que se le carga el mismo mes dos veces.
//
// La clave NO incluye el archivo, así que dos reportes que se solapan comparten
// filas. Eso no las duplica —el documento sigue siendo uno— y tampoco se las
// quita a nadie: la procedencia se acumula en `sourceFiles` (ver
// lib/retail/importaciones.ts). Las fechas de la carga van aparte, en su propio
// documento, porque son del reporte y no de las filas.
export async function POST(request: NextRequest) {
  try {
    const usuario = await requireModule("retail");
    const { template, account, sourceFile, carga, filas } = await parseJson(
      request,
      guardarAnalisisSchema
    );
    await connectDB();

    const importedAt = new Date();
    const importedBy = new Types.ObjectId(usuario.id);

    // El reporte como entidad, en dos órdenes pequeñas y en este orden.
    //
    // La primera da de alta lo que no cambia nunca (cuándo y quién lo subió por
    // primera vez) y es idempotente entre los lotes de una misma carga: el
    // índice único hace que sólo uno inserte.
    try {
      await ReportImport.updateOne(
        { account, sourceFile },
        {
          $setOnInsert: {
            template,
            importedAt,
            importedBy,
            reimportedAt: null,
            reimportedBy: null,
            loadId: carga,
          },
          $set: { lastWriteAt: importedAt },
        },
        { upsert: true }
      );
    } catch (e) {
      // Dos personas subiendo el mismo nombre a la vez: el upsert no es atómico
      // entre buscar e insertar, y el perdedor se lleva un E11000. El documento
      // existe, que es todo lo que esta orden quería.
      if (!esClaveDuplicada(e)) throw e;
    }
    // La segunda sólo dispara si el documento lo dejó OTRA carga, o sea si el
    // reporte se está volviendo a subir. Sin el filtro por `loadId`, el segundo
    // lote de una primera subida vería el documento que dejó el primero y la
    // marcaría como actualizada el mismo día en que se importó.
    await ReportImport.updateOne(
      { account, sourceFile, loadId: { $ne: carga } },
      {
        $set: {
          template,
          loadId: carga,
          reimportedAt: importedAt,
          reimportedBy: importedBy,
        },
      }
    );

    const procedencia = { template, account, sourceFile, importedAt, importedBy };

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
        SalesReport.bulkWrite(
          orden.map((f) => operacionDeFila(f, fechaUTC(f.date), procedencia)),
          { ordered: false }
        )
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

    // Los reportes salen de su propia colección: son unas decenas de documentos
    // indexados, no una agregación sobre las 15 mil filas de la cuenta.
    const reportes = await ReportImport.find(filtro)
      .sort({ lastWriteAt: -1 })
      .limit(MAX_REPORTES)
      .lean();

    if (total === 0 && reportes.length === 0) {
      return ok({ total: 0, desde: null, hasta: null, archivos: [] });
    }

    const [[rango], conteos] = await Promise.all([
      SalesReport.aggregate<{ desde: Date; hasta: Date }>([
        { $match: filtro },
        { $group: { _id: null, desde: { $min: "$date" }, hasta: { $max: "$date" } } },
      ]),
      SalesReport.aggregate<{ _id: string; filas: number }>(pipelineFilasPorArchivo(filtro)),
    ]);

    const archivos = reportesListados(reportes, conteos);
    const autores = await usuariosPorId(archivos.map((a) => a.subidoPor));

    return ok({
      total,
      desde: rango?.desde?.toISOString().slice(0, 10) ?? null,
      hasta: rango?.hasta?.toISOString().slice(0, 10) ?? null,
      archivos: archivos.map((a) => ({
        sourceFile: a.sourceFile,
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
