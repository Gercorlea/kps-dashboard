import crypto from "node:crypto";
import type { Model, Types } from "mongoose";
import { ApiError } from "@/lib/api";
import { connectDB } from "@/lib/db";
import { deleteObject, getObjectBuffer } from "@/lib/r2";
import { ForecastDiario } from "@/models/ForecastDiario";
import { LineaOC } from "@/models/LineaOC";
import { PronosticoSemanal } from "@/models/PronosticoSemanal";
import { StockCedis } from "@/models/StockCedis";
import { StockFarmacia } from "@/models/StockFarmacia";
import { Upload, type IIncidencia, type IUpload } from "@/models/Upload";
import { VentaDiaria } from "@/models/VentaDiaria";
import { parseWorkbook, type TipoHoja } from "./parse-workbook";

// Persistencia de una carga (§6.3, §7). El parseo corre en el servidor y
// se inserta con bulkWrite en lotes — nunca 37 mil upserts individuales.

const LOTE = 3000; // dentro del rango 2,000–5,000 del spec
const MAX_INCIDENCIAS_UPLOAD = 300;

/* eslint-disable @typescript-eslint/no-explicit-any */
const MODELOS: Record<TipoHoja, Model<any>> = {
  ventas: VentaDiaria,
  pronosticos: PronosticoSemanal,
  fcMean: ForecastDiario,
  cedis: StockCedis,
  invFarma: StockFarmacia,
  fillRate: LineaOC,
};
/* eslint-enable @typescript-eslint/no-explicit-any */

async function borrarFilasDeUpload(uploadId: Types.ObjectId) {
  await Promise.all(
    Object.values(MODELOS).map((model) => model.deleteMany({ uploadId }))
  );
}

// Las claves de `resumen` no pueden llevar "." (path de Mongo).
function claveHoja(name: string): string {
  return name.replace(/\./g, "·");
}

export async function procesarUpload(uploadId: string): Promise<IUpload> {
  await connectDB();
  const upload = await Upload.findById(uploadId);
  if (!upload) throw new ApiError(404, "NO_ENCONTRADO", "Carga no encontrada");
  if (upload.status === "processing") {
    throw new ApiError(409, "EN_PROCESO", "La carga ya se está procesando");
  }

  await Upload.updateOne(
    { _id: upload._id },
    { $set: { status: "processing", summary: {}, issues: [], detectedSheets: [] } }
  );

  try {
    const buffer = await getObjectBuffer(upload.r2Key);
    const fileHash = crypto.createHash("sha256").update(buffer).digest("hex");

    // Idempotencia: el mismo archivo dos veces responde 409 con el
    // uploadId existente en lugar de duplicar filas (§6.3).
    const duplicado = await Upload.findOne({ fileHash, _id: { $ne: upload._id } })
      .select({ _id: 1, filename: 1 })
      .lean();
    if (duplicado) {
      await Upload.updateOne(
        { _id: upload._id },
        {
          $set: {
            status: "error",
            issues: [
              {
                sheet: "-",
                message: `Archivo idéntico a la carga existente "${duplicado.filename}"`,
              },
            ],
            processedAt: new Date(),
          },
        }
      );
      throw new ApiError(409, "DUPLICADO", "Este fileName ya fue cargado anteriormente", {
        uploadId: String(duplicado._id),
      });
    }

    const result = parseWorkbook(buffer);

    // Reproceso: borrar primero TODAS las filas con este uploadId (§6.3).
    await borrarFilasDeUpload(upload._id);

    const issues: IIncidencia[] = [];
    const detectedSheets: string[] = [];

    for (const sheet of result.hojas) {
      detectedSheets.push(sheet.name);
      issues.push(...sheet.issues);
      if (!sheet.tipo) continue;

      const model = MODELOS[sheet.tipo];
      const meta = {
        uploadId: upload._id,
        account: upload.account,
        cutoffDate: upload.cutoffDate,
      };

      let inserted = 0;
      for (let i = 0; i < sheet.docs.length; i += LOTE) {
        const lote = sheet.docs
          .slice(i, i + LOTE)
          .map((doc) => ({ insertOne: { document: { ...doc, ...meta } } }));
        const res = await model.bulkWrite(lote, { ordered: false });
        inserted += res.insertedCount ?? 0;
      }

      // Actualización progresiva: la UI hace polling y muestra avance por hoja.
      await Upload.updateOne(
        { _id: upload._id },
        {
          $set: {
            detectedSheets,
            [`summary.${claveHoja(sheet.name)}`]: {
              read: sheet.read,
              inserted,
              rejected: sheet.rejected,
            },
          },
        }
      );
    }

    await Upload.updateOne(
      { _id: upload._id },
      {
        $set: {
          fileHash,
          status: "processed",
          detectedSheets,
          issues: issues.slice(0, MAX_INCIDENCIAS_UPLOAD),
          processedAt: new Date(),
        },
      }
    );

    const final = await Upload.findById(upload._id).lean();
    return final as unknown as IUpload;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    console.error("[ingest]", e);
    await Upload.updateOne(
      { _id: upload._id },
      {
        $set: {
          status: "error",
          issues: [{ sheet: "-", message: "Error interno al procesar el archivo" }],
          processedAt: new Date(),
        },
      }
    );
    throw new ApiError(500, "PROCESAMIENTO", "Error al procesar el archivo");
  }
}

// Borrar una carga (solo superadmin): filas en cascada + objeto en R2 (§6.3).
export async function eliminarCarga(uploadId: string): Promise<void> {
  await connectDB();
  const upload = await Upload.findById(uploadId);
  if (!upload) throw new ApiError(404, "NO_ENCONTRADO", "Carga no encontrada");
  await borrarFilasDeUpload(upload._id);
  try {
    await deleteObject(upload.r2Key);
  } catch (e) {
    console.error("[ingest] no se pudo borrar el objeto en R2", e);
  }
  await Upload.deleteOne({ _id: upload._id });
}
