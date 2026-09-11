// El ciclo de vida de una carga del catálogo.
//
// Cada subida reemplaza por completo a la anterior, pero llega en LOTES: un
// deleteMany antes de insertar dejaría el catálogo vacío —o a medias— si un lote
// falla por el camino. En su lugar, cada fila lleva el `loadId` de su carga y
// ninguna lectura mira una fila cuyo loadId no sea el de la carga ACTIVA.
//
// Ese invariante es lo que sostiene todo el módulo: una carga a medio subir,
// abandonada o fallida es exactamente igual de invisible que no existir, así que
// no hace falta ninguna transacción y el catálogo anterior sigue en pie y
// consistente mientras el nuevo se escribe.

import { CatalogLoad, type CatalogLoadStatus, type ICatalogLoad } from "@/models/CatalogLoad";
import { CatalogProduct } from "@/models/CatalogProduct";
import { ProductMapping } from "@/models/ProductMapping";

/**
 * Tras esta ventana, una carga que sigue en "loading" se considera abandonada
 * (se cerró el navegador a media subida) y sus filas se pueden borrar.
 *
 * Dos horas es holgado a propósito: subir el catálogo son segundos, y el coste
 * de esperar de más es unas filas invisibles ocupando espacio, mientras que el
 * de esperar de menos sería borrar las filas de una carga todavía en curso.
 */
export const VENTANA_CARGA_MS = 2 * 60 * 60 * 1000;

/** La carga que el módulo muestra. null = nunca se ha cargado nada. */
export async function cargaActiva(): Promise<ICatalogLoad | null> {
  // Ordenado por finalizedAt y no un findOne cualquiera: durante el instante en
  // que finalizar activa la nueva y aún no ha degradado la vieja hay DOS
  // activas, y la que vale es la más reciente. Ver el orden de escrituras en
  // api/catalogo/cargas/[carga]/finalizar.
  return CatalogLoad.findOne({ status: "active" })
    .sort({ finalizedAt: -1 })
    .lean<ICatalogLoad | null>();
}

export interface CandidataBarrido {
  loadId: string;
  status: CatalogLoadStatus;
  uploadedAt: Date;
}

/**
 * Qué cargas han dejado de estar vigentes y se pueden borrar.
 *
 * Puro para poder probarlo sin Mongo: es la decisión que, mal tomada, borra las
 * filas de una carga que alguien está subiendo en ese momento.
 *
 * - `replaced` y `failed`: ya no las mira nadie.
 * - `loading` vencidas: abandonadas.
 * - `loading` recientes: NO se tocan; puede ser otra persona subiendo ahora.
 * - `active`: nunca.
 */
export function cargasABorrar(
  candidatas: CandidataBarrido[],
  ahora: Date = new Date(),
  ventanaMs: number = VENTANA_CARGA_MS
): string[] {
  const limite = ahora.getTime() - ventanaMs;
  return candidatas
    .filter((c) => {
      if (c.status === "replaced" || c.status === "failed") return true;
      if (c.status === "loading") return c.uploadedAt.getTime() < limite;
      return false;
    })
    .map((c) => c.loadId);
}

/**
 * Borra las filas de las cargas que ya no vigen. Idempotente.
 *
 * Se llama al final de `finalizar`. Si falla, las filas quedan huérfanas pero
 * INVISIBLES —su carga ya no está activa— y el siguiente finalizar las limpia:
 * por eso el módulo no necesita un cron.
 */
export async function barrerCargas(ahora: Date = new Date()): Promise<number> {
  const candidatas = await CatalogLoad.find({ status: { $in: ["replaced", "failed", "loading"] } })
    .select({ loadId: 1, status: 1, uploadedAt: 1 })
    .lean<CandidataBarrido[]>();

  const ids = cargasABorrar(candidatas, ahora);
  if (ids.length === 0) return 0;

  const [p, m] = await Promise.all([
    CatalogProduct.deleteMany({ loadId: { $in: ids } }),
    ProductMapping.deleteMany({ loadId: { $in: ids } }),
  ]);
  return (p.deletedCount ?? 0) + (m.deletedCount ?? 0);
}

/** Borra las filas de UNA carga concreta. Para el DELETE de una carga fallida. */
export async function borrarFilasDeCarga(loadId: string): Promise<number> {
  const [p, m] = await Promise.all([
    CatalogProduct.deleteMany({ loadId }),
    ProductMapping.deleteMany({ loadId }),
  ]);
  return (p.deletedCount ?? 0) + (m.deletedCount ?? 0);
}
