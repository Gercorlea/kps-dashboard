import crypto from "node:crypto";
import type { Model, Types } from "mongoose";
import { ApiError } from "@/lib/api";
import { connectDB } from "@/lib/db";
import { DailyForecast } from "@/models/DailyForecast";
import { PurchaseOrderLine } from "@/models/PurchaseOrderLine";
import { WeeklyForecast } from "@/models/WeeklyForecast";
import { DcStock } from "@/models/DcStock";
import { PharmacyStock } from "@/models/PharmacyStock";
import { Upload, type IIncidencia, type IUpload } from "@/models/Upload";
import { DailySale } from "@/models/DailySale";
import { parseWorkbook, type TipoHoja } from "./parse-workbook";

// Persistencia de una carga (§6.3, §7). El parseo corre en el servidor y
// se inserta con bulkWrite en lotes — nunca 37 mil upserts individuales.

const LOTE = 3000; // dentro del rango 2,000–5,000 del spec
const MAX_INCIDENCIAS_UPLOAD = 300;

/* eslint-disable @typescript-eslint/no-explicit-any */
const MODELOS: Record<TipoHoja, Model<any>> = {
  sales: DailySale,
  weeklyForecast: WeeklyForecast,
  fcMean: DailyForecast,
  cedis: DcStock,
  invFarma: PharmacyStock,
  fillRate: PurchaseOrderLine,
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

// El buffer llega desde el endpoint: el Excel no se almacena en ningún sitio.
export async function procesarUpload(uploadId: string, buffer: Buffer): Promise<IUpload> {
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

// Borrar una carga (solo superadmin): filas en cascada (§6.3).
export async function eliminarCarga(uploadId: string): Promise<void> {
  await connectDB();
  const upload = await Upload.findById(uploadId);
  if (!upload) throw new ApiError(404, "NO_ENCONTRADO", "Carga no encontrada");
  await borrarFilasDeUpload(upload._id);
  // No hay archivo que borrar: el Excel nunca se guardó.
  await Upload.deleteOne({ _id: upload._id });
}
