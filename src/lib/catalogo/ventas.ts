// El cruce entre un producto del catálogo y las ventas que ya están en la base.
//
// SalesReport guarda el `itemNbr` del retailer, no el Item de KPS, así que el
// puente es la hoja de mapeo: para cada canal, el código con el que esa cadena
// compra el producto. Sin ese mapeo no hay forma de responder "cuántas unidades
// de PTAL001 vendió Walmart".

import type { PipelineStage } from "mongoose";
import { fechaISO } from "@/lib/retail/normalize";
import { SalesReport } from "@/models/SalesReport";
import type { VentaCanal } from "./tipos";

/** Un par (cuenta, artículo) tal como lo indexa SalesReport. */
export interface ParCanal {
  account: string;
  itemNbr: number;
}

/** Lo mínimo que necesita `paresCruzables` de una fila de mapeo. */
export interface MapeoCruzable {
  channel: string;
  knownRetailer: boolean;
  customerCodeNum: number | null;
}

/**
 * Los pares que se pueden preguntar a SalesReport.
 *
 * Se descartan dos casos, y por motivos distintos:
 * - canal desconocido: no hay ninguna cuenta con ese id en la base, así que
 *   preguntar por él es tiempo perdido;
 * - código no numérico: `itemNbr` es Number y un texto nunca igualaría; cruzar
 *   "por lo parecido" le atribuiría a un producto las ventas de otro.
 *
 * Se deduplica porque el mismo par en dos filas del Excel sumaría doble.
 */
export function paresCruzables(mapeos: MapeoCruzable[]): ParCanal[] {
  const vistos = new Set<string>();
  const pares: ParCanal[] = [];
  for (const m of mapeos) {
    if (!m.knownRetailer || m.customerCodeNum === null) continue;
    const clave = `${m.channel}|${m.customerCodeNum}`;
    if (vistos.has(clave)) continue;
    vistos.add(clave);
    pares.push({ account: m.channel, itemNbr: m.customerCodeNum });
  }
  return pares;
}

/**
 * Unidades e importe vendidos por canal, para UN producto.
 *
 * El $match es un $or de igualdades sobre (account, itemNbr), que es el PREFIJO
 * del índice único { account, itemNbr, date } de SalesReport: Mongo resuelve
 * cada rama del $or por ese índice, así que la consulta toca sólo las filas del
 * producto y no la colección. Por eso el código del cliente se guarda también
 * como número en ProductMapping.customerCodeNum: con un $toLong dentro del
 * pipeline el índice no se usaría y esto sería un recorrido completo.
 *
 * Devuelve null cuando no hay ningún par cruzable: un $or vacío es un error en
 * Mongo, y además no habría nada que preguntar.
 */
export function pipelineVentasPorCanal(pares: ParCanal[]): PipelineStage[] | null {
  if (pares.length === 0) return null;
  return [
    { $match: { $or: pares.map((p) => ({ account: p.account, itemNbr: p.itemNbr })) } },
    {
      $group: {
        _id: { account: "$account", itemNbr: "$itemNbr" },
        unidades: { $sum: "$posQty" },
        importe: { $sum: "$posSales" },
        filas: { $sum: 1 },
        desde: { $min: "$date" },
        hasta: { $max: "$date" },
      },
    },
    { $sort: { unidades: -1 } },
  ];
}

interface FilaAgregada {
  _id: { account: string; itemNbr: number };
  unidades: number;
  importe: number;
  filas: number;
  desde: Date | null;
  hasta: Date | null;
}

/** Clave con la que la ficha busca las ventas de una fila de mapeo. */
export function claveVenta(channel: string, itemNbr: number): string {
  return `${channel}|${itemNbr}`;
}

/**
 * Ejecuta el cruce y devuelve "canal|codigo" → agregado.
 *
 * Un canal cruzable que no aparece en el mapa no tiene ventas en la base, y eso
 * es información, no un error: hoy sólo Walmart tiene reportes cargados.
 */
export async function ventasPorCanal(
  mapeos: MapeoCruzable[]
): Promise<Map<string, VentaCanal>> {
  const pipeline = pipelineVentasPorCanal(paresCruzables(mapeos));
  if (!pipeline) return new Map();

  const filas = await SalesReport.aggregate<FilaAgregada>(pipeline);
  return new Map(
    filas.map((f) => [
      claveVenta(f._id.account, f._id.itemNbr),
      {
        unidades: f.unidades,
        importe: f.importe,
        filas: f.filas,
        desde: f.desde ? fechaISO(f.desde) : null,
        hasta: f.hasta ? fechaISO(f.hasta) : null,
      },
    ])
  );
}
