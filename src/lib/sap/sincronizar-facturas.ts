import { connectDB } from "@/lib/db";
import { SapInvoiceBatch } from "@/models/SapInvoiceBatch";
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
    // Lotes de los que salió la línea. El Service Layer los manda dentro de
    // cada línea cuando se pide DocumentLines; vacío si el artículo no
    // maneja lotes.
    BatchNumbers?: Array<{
      BatchNumber?: string | null;
      Quantity?: number;
      ExpiryDate?: string | null;
    }>;
  }>;
}

export interface ResultadoSync {
  facturas: number;
  lineas: number;
  lotes: number;
  desdeDocEntry: number;
}

/**
 * Trae de SAP las facturas con DocEntry mayor al último sincronizado y
 * upsertea sus líneas y sus lotes. Se saltan las canceladas y las líneas sin
 * artículo (documentos de "Saldo inicial", que no son ventas).
 *
 * `desdeCero` recorre TODO el histórico aunque ya esté copiado: es idempotente
 * (upsert por llave natural) y sirve para rellenar datos que se añadieron
 * después del primer volcado, como los lotes.
 */
export async function sincronizarFacturas(
  opciones: { desdeCero?: boolean; maxPaginas?: number; presupuestoMs?: number } = {}
): Promise<ResultadoSync> {
  await connectDB();
  const ultimo = opciones.desdeCero
    ? null
    : await SapInvoiceLine.findOne().sort({ docEntry: -1 }).select("docEntry").lean();
  const desde = ultimo?.docEntry ?? 0;
  const inicio = Date.now();
  let paginas = 0;

  let facturas = 0;
  let lineas = 0;
  let lotes = 0;
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

    const opsLotes = pagina.flatMap((f) =>
      (f.DocumentLines ?? [])
        .filter((l) => l.ItemCode)
        .flatMap((l) =>
          (l.BatchNumbers ?? [])
            .filter((b) => b.BatchNumber)
            .map((b) => ({
              updateOne: {
                filter: { docEntry: f.DocEntry, lineNum: l.LineNum, batch: b.BatchNumber! },
                update: {
                  $set: {
                    docNum: f.DocNum,
                    docDate: new Date(`${f.DocDate}T00:00:00.000Z`),
                    cardCode: f.CardCode ?? "",
                    cardName: f.CardName ?? "",
                    itemCode: l.ItemCode!,
                    description: l.ItemDescription ?? "",
                    quantity: b.Quantity ?? 0,
                    expiryDate: b.ExpiryDate ? new Date(`${b.ExpiryDate.slice(0, 10)}T00:00:00.000Z`) : null,
                    syncedAt: ahora,
                  },
                },
                upsert: true,
              },
            }))
        )
    );
    if (opsLotes.length) {
      const r = await SapInvoiceBatch.bulkWrite(opsLotes, { ordered: false });
      lotes += r.upsertedCount + r.modifiedCount;
    }
    facturas += pagina.length;
    cursor = pagina[pagina.length - 1].DocEntry;
    if (pagina.length < LOTE) break;
    // Presupuesto para el uso desde el chat: lo que no quepa lo recoge la
    // siguiente corrida (el cursor por DocEntry hace la sync reanudable).
    paginas++;
    if (opciones.maxPaginas && paginas >= opciones.maxPaginas) break;
    if (opciones.presupuestoMs && Date.now() - inicio >= opciones.presupuestoMs) break;
  }

  return { facturas, lineas, lotes, desdeDocEntry: desde };
}

// Frescura para el uso desde el chat: sincronizar como mucho una vez cada
// 5 minutos por proceso, y SOLO de forma incremental y acotada. El volcado
// inicial (~450 páginas, varios minutos) es trabajo de `npm run sap:facturas`:
// con la copia vacía, una pregunta del chat se quedaba 4-5 minutos colgada
// recorriendo todo SAP dentro de la petición (y en Vercel no llegaba a
// escribir nada, así que se repetía cada 5 minutos).
const FRESCURA_MS = 5 * 60_000;
const SYNC_CHAT_PRESUPUESTO_MS = 20_000;
const SYNC_CHAT_MAX_PAGINAS = 10;
let ultimaSync = 0;
let syncEnCurso: Promise<ResultadoSync> | null = null;

export async function asegurarFacturasFrescas(): Promise<void> {
  if (Date.now() - ultimaSync < FRESCURA_MS) return;
  await connectDB();
  const hayCopia = await SapInvoiceLine.exists({});
  if (!hayCopia) {
    // Sin volcado inicial no hay nada que refrescar: se responde "sin datos"
    // al instante y se deja constancia para quien opere el sistema.
    ultimaSync = Date.now();
    console.warn("[sapSales] copia vacía: falta correr `npm run sap:facturas -- --completo`; no se sincroniza desde el chat");
    return;
  }
  syncEnCurso ??= sincronizarFacturas({
    maxPaginas: SYNC_CHAT_MAX_PAGINAS,
    presupuestoMs: SYNC_CHAT_PRESUPUESTO_MS,
  }).finally(() => {
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
