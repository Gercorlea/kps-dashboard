import type { PipelineStage } from "mongoose";
import { handleApiError, ok } from "@/lib/api";
import { requireModule } from "@/lib/auth/guards";
import { cargaActiva } from "@/lib/catalogo/cargas";
import type { Faceta, ResumenCatalogo } from "@/lib/catalogo/tipos";
import { connectDB } from "@/lib/db";
import { usuariosPorId } from "@/lib/usuarios";
import { CatalogProduct } from "@/models/CatalogProduct";
import { ProductMapping } from "@/models/ProductMapping";

// GET /api/catalogo/resumen — la cabecera y las opciones de los filtros.
//
// Un solo viaje al montar el módulo: qué archivo está activo, quién lo subió, y
// los valores distintos de Línea, Estatus y Canal para poblar los `select`.

interface FilaFaceta {
  _id: string;
  etiqueta: string;
  filas: number;
}

/**
 * Agrupa por un campo de texto SIN distinguir mayúsculas, mostrando la grafía
 * más frecuente.
 *
 * El archivo mezcla "Activo" y "activo", y sin esto el menú de Estatus ofrecería
 * las dos como si fueran cosas distintas. Se guarda el texto original —es lo que
 * se muestra en la tabla— y sólo se pliega para las opciones del filtro.
 */
function pipelineFaceta(loadId: string, campo: string): PipelineStage[] {
  return [
    { $match: { loadId, [campo]: { $ne: "" } } },
    {
      $group: {
        _id: { $toLower: `$${campo}` },
        // La grafía más frecuente, no la primera que aparezca: si 130 filas
        // dicen "Activo" y 2 dicen "activo", la opción debe decir "Activo".
        grafias: { $push: `$${campo}` },
        filas: { $sum: 1 },
      },
    },
    { $sort: { filas: -1, _id: 1 } },
  ];
}

function masFrecuente(grafias: string[]): string {
  const conteo = new Map<string, number>();
  for (const g of grafias) conteo.set(g, (conteo.get(g) ?? 0) + 1);
  let mejor = grafias[0] ?? "";
  let max = 0;
  for (const [g, n] of conteo) {
    if (n > max) {
      max = n;
      mejor = g;
    }
  }
  return mejor;
}

export async function GET() {
  try {
    await requireModule("catalogo");
    await connectDB();

    const carga = await cargaActiva();
    if (!carga) {
      // Nunca se ha subido nada. Se devuelve la envoltura vacía en vez de un
      // error para que la UI pinte su estado vacío con la zona de carga.
      const vacio: ResumenCatalogo = {
        carga: null,
        lineas: [],
        estatus: [],
        canales: [],
        productosSinMapeo: 0,
      };
      return ok(vacio);
    }

    const loadId = carga.loadId;

    const [lineasRaw, estatusRaw, canalesRaw, items, skus, autores] = await Promise.all([
      CatalogProduct.aggregate<FilaFaceta & { grafias: string[] }>(
        pipelineFaceta(loadId, "line")
      ),
      CatalogProduct.aggregate<FilaFaceta & { grafias: string[] }>(
        pipelineFaceta(loadId, "status")
      ),
      // Los canales ya vienen normalizados a slug, así que aquí no hace falta
      // plegar grafías: se agrupa por el id y se conserva su nombre y si es
      // conocido, que son propiedades del canal y no de la fila.
      ProductMapping.aggregate<{
        _id: string;
        nombre: string;
        conocido: boolean;
        filas: number;
      }>([
        { $match: { loadId } },
        {
          $group: {
            _id: "$channel",
            nombre: { $first: "$channelName" },
            conocido: { $first: "$knownRetailer" },
            filas: { $sum: 1 },
          },
        },
        { $sort: { filas: -1, _id: 1 } },
      ]),
      CatalogProduct.distinct("item", { loadId }),
      ProductMapping.distinct("sku", { loadId }),
      usuariosPorId([carga.uploadedBy]),
    ]);

    const conMapeo = new Set(skus as string[]);
    const productosSinMapeo = (items as string[]).filter((i) => !conMapeo.has(i)).length;

    const aFaceta = (f: FilaFaceta & { grafias: string[] }): Faceta => ({
      id: f._id,
      etiqueta: masFrecuente(f.grafias),
      filas: f.filas,
    });

    const resumen: ResumenCatalogo = {
      carga: {
        loadId,
        filename: carga.filename,
        productos: carga.productCount,
        mapeos: carga.mappingCount,
        descartados: {
          productos: carga.discardedProducts,
          mapeos: carga.discardedMappings,
        },
        huerfanos: carga.orphanMappings,
        finalizadaEl: carga.finalizedAt?.toISOString() ?? null,
        subidaPor: autores.get(String(carga.uploadedBy)) ?? null,
        incidencias: carga.issues,
      },
      lineas: lineasRaw.map(aFaceta),
      estatus: estatusRaw.map(aFaceta),
      canales: canalesRaw.map((c) => ({
        id: c._id,
        etiqueta: c.nombre || c._id,
        filas: c.filas,
        conocido: c.conocido,
      })),
      productosSinMapeo,
    };

    return ok(resumen);
  } catch (e) {
    return handleApiError(e);
  }
}
