import { connectDB } from "@/lib/db";
import { SapInvoiceLine } from "@/models/SapInvoiceLine";
import { sapFetch } from "./service-layer";

// Sincroniza las líneas de factura de SAP hacia MongoDB (colección sapSales
// de consultar_retail). Incremental por DocEntry: tras el volcado inicial
// (~450 peticiones, una vez) cada corrida solo trae las facturas nuevas —
// normalmente 1 o 2 peticiones—, así que es barata de llamar seguido.

const LOTE = 20; // el Service Layer pagina de 20 en 20 (PageSize de b1s.conf)

interface FacturaSap {
  DocEntry: number;
  DocNum: number;
  DocDate: string;
  CardCode?: string;
  CardName?: string;
  Cancelled?: string; // tYES cuando la factura fue cancelada
  DocCurrency?: string;
  DocumentLines?: Array<{
    LineNum: number;
    ItemCode?: string | null;
    ItemDescription?: string | null;
    Quantity?: number;
    Price?: number;
    LineTotal?: number;
  }>;
}

export interface ResultadoSync {
  facturas: number;
  lineas: number;
  desdeDocEntry: number;
}

/**
 * Trae de SAP las facturas con DocEntry mayor al último sincronizado y
 * upsertea sus líneas. Se saltan las canceladas y las líneas sin artículo
 * (documentos de "Saldo inicial", que no son ventas).
 */
export async function sincronizarFacturas(): Promise<ResultadoSync> {
  await connectDB();
  const ultimo = await SapInvoiceLine.findOne().sort({ docEntry: -1 }).select("docEntry").lean();
  const desde = ultimo?.docEntry ?? 0;

  let facturas = 0;
  let lineas = 0;
  // Paginacion por cursor de DocEntry, no por $skip: con $skip el Service
  // Layer re-ordena y re-recorre todo lo saltado en cada pagina (el volcado
  // completo se volvia cuadratico); con `gt cursor` cada pagina es una
  // consulta indexada nueva de costo constante.
  let cursor = desde;

  for (;;) {
    const params = new URLSearchParams({
      $filter: `DocEntry gt ${cursor} and Cancelled eq 'tNO'`,
      $select: "DocEntry,DocNum,DocDate,CardCode,CardName,Cancelled,DocCurrency,DocumentLines",
      $orderby: "DocEntry asc",
      $top: String(LOTE),
    });

    const data = await sapFetch<{ value?: FacturaSap[] }>(`/Invoices?${params.toString()}`, {
      headers: { Prefer: `odata.maxpagesize=${LOTE}` },
    });
    const pagina = data.value ?? [];
    if (!pagina.length) break;

    const ahora = new Date();
    const ops = pagina.flatMap((f) =>
      (f.DocumentLines ?? [])
        .filter((l) => l.ItemCode) // sin artículo = saldo inicial, no venta
        .map((l) => ({
          updateOne: {
            filter: { docEntry: f.DocEntry, lineNum: l.LineNum },
            update: {
              $set: {
                docNum: f.DocNum,
                docDate: new Date(`${f.DocDate}T00:00:00.000Z`),
                cardCode: f.CardCode ?? "",
                cardName: f.CardName ?? "",
                itemCode: l.ItemCode!,
                description: l.ItemDescription ?? "",
                quantity: l.Quantity ?? 0,
                price: l.Price ?? 0,
                lineTotal: l.LineTotal ?? 0,
                currency: f.DocCurrency ?? "MXP",
                syncedAt: ahora,
              },
            },
            upsert: true,
          },
        }))
    );
    if (ops.length) {
      const r = await SapInvoiceLine.bulkWrite(ops, { ordered: false });
      lineas += r.upsertedCount + r.modifiedCount;
    }
    facturas += pagina.length;
    cursor = pagina[pagina.length - 1].DocEntry;
    if (pagina.length < LOTE) break;
  }

  return { facturas, lineas, desdeDocEntry: desde };
}

// Frescura para el uso desde el chat: sincronizar como mucho una vez cada
// 5 minutos por proceso. La primera pregunta del día paga 1-2 peticiones a
// SAP; las siguientes leen Mongo directo.
const FRESCURA_MS = 5 * 60_000;
let ultimaSync = 0;
let syncEnCurso: Promise<ResultadoSync> | null = null;

export async function asegurarFacturasFrescas(): Promise<void> {
  if (Date.now() - ultimaSync < FRESCURA_MS) return;
  syncEnCurso ??= sincronizarFacturas().finally(() => {
    syncEnCurso = null;
  });
  try {
    await syncEnCurso;
    ultimaSync = Date.now();
  } catch (e) {
    // SAP caído no debe tumbar la consulta: se responde con lo ya copiado,
    // que como mínimo llega hasta la última sincronización buena.
    console.error("[sapSales] no se pudo sincronizar; se usa la copia local", e);
  }
}
