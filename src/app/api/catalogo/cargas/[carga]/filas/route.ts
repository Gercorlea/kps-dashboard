import type { NextRequest } from "next/server";
import { ApiError, handleApiError, ok, parseJson } from "@/lib/api";
import { requireModule } from "@/lib/auth/guards";
import { connectDB } from "@/lib/db";
import { lotesCargaSchema } from "@/lib/validation/catalogo";
import { CatalogLoad } from "@/models/CatalogLoad";
import { CatalogProduct } from "@/models/CatalogProduct";
import { ProductMapping } from "@/models/ProductMapping";

/**
 * Cuántas órdenes de escritura salen en paralelo por cada lote recibido.
 *
 * Se copia el valor del analizador de retail, donde está medido contra el
 * clúster real: el cuello no son los bytes sino la latencia de cada upsert, y lo
 * único que la tapa es tener varias órdenes en vuelo. Ver la medición completa
 * en app/api/retail/analisis/route.ts.
 *
 * Con ~140 productos el lote entra en una sola orden y esto no se nota; está
 * aquí para que un catálogo que crezca no cambie de comportamiento.
 */
const ORDENES_EN_PARALELO = 8;

/** "2024-09-01" → medianoche UTC, como el resto del proyecto. */
function fechaUTC(iso: string): Date {
  const [a, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(a, m - 1, d));
}

/**
 * Filas sin claves repetidas, quedándose con la ÚLTIMA.
 *
 * El cliente ya deduplica, pero esto no es redundante: al repartir el lote en
 * órdenes paralelas, dos filas con la misma clave podrían caer en órdenes
 * distintas y competir entre sí, y el resultado dependería de cuál llegara
 * antes. Mismo motivo y misma forma que `sinClavesRepetidas` en el analizador.
 */
function sinClavesRepetidas<T>(filas: T[], clave: (f: T) => string): T[] {
  const porClave = new Map<string, T>();
  for (const f of filas) porClave.set(clave(f), f);
  return [...porClave.values()];
}

/** Reparte en órdenes disjuntas para mandarlas a la vez. */
function repartir<T>(filas: T[]): T[][] {
  const porOrden = Math.ceil(filas.length / ORDENES_EN_PARALELO);
  const ordenes: T[][] = [];
  for (let i = 0; i < filas.length; i += porOrden) {
    ordenes.push(filas.slice(i, i + porOrden));
  }
  return ordenes;
}

// POST /api/catalogo/cargas/[carga]/filas — escribe un lote.
//
// Upsert por la clave natural del grano, así que reenviar un lote —porque la red
// falló a medias— actualiza en vez de duplicar.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ carga: string }> }
) {
  try {
    const usuario = await requireModule("catalogo");
    const { carga } = await params;
    const lote = await parseJson(request, lotesCargaSchema);
    await connectDB();

    // Sólo se escribe en una carga abierta y propia. Sin el filtro por dueño,
    // conocer un loadId permitiría contaminar la subida de otra persona; sin el
    // filtro por estado, se podrían añadir filas a un catálogo ya activo y
    // aparecerían sin pasar por ninguna comprobación de finalizar.
    const doc = await CatalogLoad.findOne({ loadId: carga })
      .select({ status: 1, uploadedBy: 1 })
      .lean();
    if (!doc) throw new ApiError(404, "CARGA_NO_ENCONTRADA", "La carga no existe.");
    if (doc.status !== "loading") {
      throw new ApiError(409, "CARGA_CERRADA", "Esta carga ya se cerró; empieza una nueva.");
    }
    if (String(doc.uploadedBy) !== usuario.id) {
      throw new ApiError(403, "SIN_PERMISO", "Esta carga la abrió otra persona.");
    }

    let insertadas = 0;
    let actualizadas = 0;

    if (lote.tipo === "productos") {
      const unicas = sinClavesRepetidas(lote.filas, (f) => f.item);
      const res = await Promise.all(
        repartir(unicas).map((orden) =>
          CatalogProduct.bulkWrite(
            orden.map((f) => ({
              updateOne: {
                filter: { loadId: carga, item: f.item },
                update: {
                  $set: {
                    description: f.description,
                    status: f.status,
                    line: f.line,
                    ecom: f.ecom,
                    trello: f.trello,
                    salesUnit: f.salesUnit,
                    upc: f.upc,
                    satCode: f.satCode,
                    tariffCode: f.tariffCode,
                    suv: f.suv,
                    grammage: f.grammage,
                    shelfLifeMonths: f.shelfLifeMonths,
                    launchDate: f.launchDate ? fechaUTC(f.launchDate) : null,
                    launchDateText: f.launchDateText,
                    suppliers: f.suppliers,
                    rowNumber: f.rowNumber,
                  },
                },
                upsert: true,
              },
            })),
            { ordered: false }
          )
        )
      );
      insertadas = res.reduce((n, r) => n + r.upsertedCount, 0);
      actualizadas = res.reduce((n, r) => n + r.modifiedCount, 0);
    } else {
      const unicas = sinClavesRepetidas(lote.filas, (f) => `${f.sku}|${f.channel}`);
      const res = await Promise.all(
        repartir(unicas).map((orden) =>
          ProductMapping.bulkWrite(
            orden.map((f) => ({
              updateOne: {
                filter: { loadId: carga, sku: f.sku, channel: f.channel },
                update: {
                  $set: {
                    channelName: f.channelName,
                    knownRetailer: f.knownRetailer,
                    customerCode: f.customerCode,
                    customerCodeNum: f.customerCodeNum,
                    description: f.description,
                    rowNumber: f.rowNumber,
                  },
                },
                upsert: true,
              },
            })),
            { ordered: false }
          )
        )
      );
      insertadas = res.reduce((n, r) => n + r.upsertedCount, 0);
      actualizadas = res.reduce((n, r) => n + r.modifiedCount, 0);
    }

    return ok({ tipo: lote.tipo, recibidas: lote.filas.length, insertadas, actualizadas });
  } catch (e) {
    return handleApiError(e);
  }
}
