import { sapFetch, sapUpload, SapError } from "@/lib/sap/service-layer";
import { AuditLog, Invoice, InvoiceEvent, StoredDocument } from "@/models/proveedores";

/**
 * Registra en Business One una factura ya aprobada por KPS.
 *
 * QUE HACE Y EN QUE ORDEN. Son cuatro llamadas y el orden no es negociable:
 *
 *   1. GET   /PurchaseInvoices?$filter=NumAtCard eq '<uuid>'   idempotencia
 *   2. POST  /PurchaseInvoices                                 crea la factura
 *   3. POST  /Attachments2                                     sube XML y PDF
 *   4. PATCH /PurchaseInvoices(<DocEntry>)                     enlaza los adjuntos
 *
 * EL PASO 1 NO ES OPCIONAL. El Service Layer no tiene clave de idempotencia
 * (§04 principio 3). Si el paso 2 responde y el guardado local falla —o el
 * request muere por timeout con la factura ya creada—, al reintentar el paso 1
 * es lo unico que impide crear la misma factura dos veces en contabilidad. Una
 * factura duplicada no se puede borrar en B1: se corrige con nota de credito.
 *
 * SE COPIA DE LA ENTRADA, NO DE LA ORDEN. Cada renglon va con BaseType 20 +
 * BaseEntry + BaseLine, y sin `Quantity`: asi B1 factura todo lo que quede
 * abierto y hereda articulo, precio e impuestos del renglon de la entrada. Es lo
 * que salda la CUENTA DE DOTACION (2010030000), la cuenta puente donde vive la
 * mercancia recibida sin facturar. Facturar contra la orden (BaseType 22) crea
 * la deuda al proveedor SIN saldar esa cuenta: la misma compra contada dos veces
 * y un saldo que crece sin que nadie sepa por que.
 *
 * NO SE MANDAN IMPORTES. Ni precio, ni IVA, ni total. Los recalcula B1 desde la
 * entrada, y esa es la cifra que queda en contabilidad. Por eso el cotejo tiene
 * que haber pasado ANTES: despues del POST ya no hay nada que ajustar.
 *
 * LOS ADJUNTOS NO SON TRANSACCIONALES. Van despues y con su propio try/catch: si
 * fallan, la factura ya existe en B1 y no hay forma de deshacerla desde aqui. Un
 * adjunto que falta se vuelve a subir; una factura duplicada, no.
 *
 * SOBRE §04 PRINCIPIO 2. El principio pide que ninguna llamada a SAP ocurra
 * dentro de un request HTTP, y esto lo incumple: no hay workers de cola en el
 * proyecto todavia. Queda acotado porque el fallo es recuperable —el paso 1 hace
 * el reintento seguro— y porque quien aprueba esta delante de la pantalla
 * esperando saber si entro. Cuando exista la cola, este modulo se llama igual
 * desde el worker sin tocar nada de aqui.
 */

/** ObjectTypes de B1. 20 = entrada de mercancia, 18 = factura de compra. */
const OBJECT_TYPE = { entrada: 20, factura: 18 } as const;

/**
 * Donde vive el UUID del CFDI en las facturas de compra de KPS.
 *
 * B1 no tiene campo estandar para el UUID fiscal (§00 consecuencia 06), asi que
 * cada instalacion elige uno. En la de KPS es este campo de usuario, y esta
 * comprobado contra los datos: de las ultimas 100 facturas de compra, 93 traen
 * `U_UDF_UUID` con un UUID.
 *
 * NO SE USA `NumAtCard`, aunque sea la salida "obvia" y el default de la
 * configuracion del portal. Ese campo YA LO USA KPS para la referencia del
 * proveedor —el folio de su factura: 5996, 4485, 63965506— en 98 de esas 100.
 * Escribir ahi el UUID pisa un dato del negocio y ademas rompe la idempotencia,
 * porque la busqueda previa mirara un campo que casi siempre contiene otra cosa.
 */
const CAMPO_UUID = "U_UDF_UUID";

/** Estado desde el que se puede registrar. Solo lo aprobado va a B1. */
export const REGISTRABLE = "APROBADA_PAGO";

export type MotivoNoRegistro =
  | "SIN_UUID"
  | "SIN_ENTRADA"
  | "ENTRADA_NO_EXISTE"
  | "ENTRADA_CERRADA"
  | "ENTRADA_CANCELADA"
  | "SIN_RENGLONES"
  | "ES_SERVICIO"
  | "COTEJO"
  | "RETENCIONES"
  | "SAP";

/**
 * Traduccion de impuesto retenido del CFDI al `WTCode` de Business One.
 *
 * Formato: `002:IVA_RET_4,001:ISR_RET_10`. La clave es el codigo del SAT
 * (001 ISR, 002 IVA, 003 IEPS); el valor, el codigo de retencion de B1.
 *
 * VACIO POR DEFECTO. Los `WTCode` son de la instalacion de KPS y nadie fuera de
 * KPS los conoce, asi que mientras esto este vacio una factura CON retenciones
 * no se registra. Es a proposito: registrarla sin ellas la deja por su importe
 * bruto, y el pago que salga de ahi le entrega al proveedor lo que ya se le
 * retuvo para el SAT. Ese dinero no vuelve.
 */
function codigosDeRetencion(): Map<string, string> {
  const mapa = new Map<string, string>();
  for (const par of (process.env.RETENCIONES_WT_CODES ?? "").split(",")) {
    const [clave, codigo] = par.split(":").map((x) => x.trim());
    if (clave && codigo) mapa.set(clave, codigo);
  }
  return mapa;
}

/** Nombre legible de un impuesto del catalogo c_Impuesto. */
function nombreImpuesto(clave: string): string {
  if (clave === "001") return "ISR";
  if (clave === "002") return "IVA";
  if (clave === "003") return "IEPS";
  return `impuesto ${clave}`;
}

/** Una retencion del CFDI, tal como la guarda el portal. */
interface RetencionGuardada {
  impuesto: string;
  tipoFactor: string;
  tasaOCuota: string | null;
  base: string;
  importe: string;
}

export class RegistroSapError extends Error {
  constructor(
    readonly motivo: MotivoNoRegistro,
    message: string
  ) {
    super(message);
    this.name = "RegistroSapError";
  }
}

interface LineaB1 {
  LineNum: number;
  Quantity: number;
  RemainingOpenQuantity?: number | null;
}

interface EntradaB1 {
  DocEntry: number;
  DocNum: number;
  CardCode: string;
  DocDate?: string | null;
  DocCurrency?: string | null;
  DocumentStatus: string;
  Cancelled?: string | null;
  DocumentLines?: LineaB1[];
}

interface FacturaB1 {
  DocEntry: number;
  DocNum: number;
  DocTotal?: number | null;
  VatSum?: number | null;
  /**
   * Fecha de vencimiento. NO se manda en el payload: la calcula B1 desde las
   * condiciones de pago del proveedor —30 dias, 60, las que tenga pactadas— y
   * viene de vuelta en la respuesta. Se guarda para poder decirle al proveedor
   * cuando cobra sin volver a preguntarle a SAP en cada pantalla.
   */
  DocDueDate?: string | null;
}

export interface ResultadoRegistro {
  docEntry: number;
  docNum: number;
  /** La factura ya existia en B1: no se creo otra. */
  reusada: boolean;
  attachmentEntry: number | null;
  /** Los adjuntos fallaron pero la factura si entro. */
  avisoAdjuntos: string | null;
}

/** B1 acepta la fecha sin hora ni zona. */
function fechaB1(d: Date | null | undefined): string {
  return (d ?? new Date()).toISOString().slice(0, 10);
}

/**
 * Cuanto queda abierto en un renglon.
 *
 * Sin `RemainingOpenQuantity` se cae a la cantidad recibida: es el limite mas
 * permisivo y B1 rechazara igual el exceso. Se prefiere dejar decidir a B1 antes
 * que descartar un renglon legitimo por un campo que el $select no trajo.
 */
function abiertaDe(l: LineaB1): number {
  const abierta = l.RemainingOpenQuantity;
  return abierta === null || abierta === undefined ? l.Quantity : abierta;
}

/**
 * Busca la factura por el UUID del CFDI. Es lo que hace idempotente el registro.
 *
 * La comparacion va sobre el UUID en mayusculas y en minusculas porque en la
 * base conviven las dos formas —el add-on de facturacion electronica escribe
 * unas en mayusculas y otras no— y el filtro de OData distingue. Buscar solo una
 * daria "no existe" para facturas que si estan, y el registro las duplicaria.
 */
async function buscarPorUuid(uuid: string): Promise<FacturaB1 | null> {
  const escapar = (s: string) => s.replace(/'/g, "''");
  const filtro = encodeURIComponent(
    `${CAMPO_UUID} eq '${escapar(uuid.toUpperCase())}' or ${CAMPO_UUID} eq '${escapar(uuid.toLowerCase())}'`
  );
  const data = await sapFetch<{ value?: FacturaB1[] }>(
    `/PurchaseInvoices?$filter=${filtro}&$select=DocEntry,DocNum,DocTotal,VatSum,DocDueDate&$top=1`
  );
  return data.value?.[0] ?? null;
}

/** Adjunta XML y PDF a la factura. Devuelve el AbsoluteEntry, o null si no habia nada. */
async function adjuntar(
  docEntry: number,
  folio: string,
  claves: { xmlFileKey: string | null; pdfFileKey: string | null }
): Promise<number | null> {
  const archivos = [
    { key: claves.xmlFileKey, ext: "xml" },
    { key: claves.pdfFileKey, ext: "pdf" },
  ].filter((a): a is { key: string; ext: string } => Boolean(a.key));

  if (archivos.length === 0) return null;

  const form = new FormData();
  let puestos = 0;

  for (const a of archivos) {
    const doc = await StoredDocument().findById(a.key).lean();
    if (!doc?.bytes) continue;
    // `Uint8Array` y no el Buffer crudo: Blob no acepta un Buffer de Node
    // directamente en todas las versiones de undici.
    form.append("files", new Blob([new Uint8Array(doc.bytes)]), `${folio}.${a.ext}`);
    puestos++;
  }

  if (puestos === 0) return null;

  const creado = await sapUpload<{ AbsoluteEntry: number }>("/Attachments2", form);
  await sapFetch(`/PurchaseInvoices(${docEntry})`, {
    method: "PATCH",
    body: JSON.stringify({ AttachmentEntry: creado.AbsoluteEntry }),
  });
  return creado.AbsoluteEntry;
}

/**
 * Registra la factura del folio dado en Business One y deja constancia local.
 *
 * Lanza `RegistroSapError` con el motivo cuando no se puede registrar. Quien
 * llama decide si eso tumba la aprobacion o solo se avisa: hoy la aprobacion ya
 * ocurrio y esto es el paso siguiente, asi que se avisa.
 */
export async function registrarFacturaEnSap(datos: {
  folio: string;
  actorId: string;
  actorRole: string;
}): Promise<ResultadoRegistro> {
  const { folio, actorId, actorRole } = datos;

  const f = await Invoice().findOne({ folio }).lean();
  if (!f) throw new RegistroSapError("SIN_ENTRADA", `No existe la petición ${folio}.`);

  if (f.type === "SERVICIO") {
    throw new RegistroSapError(
      "ES_SERVICIO",
      `${folio} es de servicio: se registra como dDocument_Service con cuenta contable, y ese flujo todavía no está conectado.`
    );
  }

  if (!f.uuid) {
    throw new RegistroSapError(
      "SIN_UUID",
      `${folio} no tiene UUID fiscal. Sin él no se puede comprobar si ya está en Business One y el registro podría duplicarse.`
    );
  }

  // --- El cotejo tiene que haber cuadrado ---------------------------------
  //
  // ES EL ÚLTIMO MOMENTO EN QUE SE PUEDE PARAR. Después del POST, B1 registra la
  // factura con los importes de la ENTRADA —no con los del CFDI— y ya no hay
  // nada que ajustar: una factura de compra no se borra en B1, se corrige con
  // nota de crédito. Si el CFDI dice 29,000 y la entrada vale 29, sin esta
  // comprobación se registran 29 y la diferencia queda esperando a que alguien
  // cuadre la cuenta de dotación meses después.
  //
  // El campo lo escribe el portal al cargar el XML; se lee con cast porque el
  // esquema de aquí solo transporta lo que el portal define (igual que
  // `baseEntry`).
  const cotejo = (f as { matchResult?: Record<string, unknown> | null }).matchResult ?? null;
  if (cotejo && cotejo.canProceed === false) {
    const resumen = typeof cotejo.summary === "string" ? cotejo.summary : "";
    throw new RegistroSapError(
      "COTEJO",
      `${folio} no cuadra con la entrada ${cotejo.receiptNumber ?? ""}. ${resumen} Business One registraría los importes de la entrada, no los del CFDI, así que la diferencia quedaría sin cuadrar. Pide al proveedor una factura corregida o una nota de crédito antes de registrarla.`.trim()
    );
  }

  // --- Las retenciones, o no se registra ----------------------------------
  const retenciones =
    ((f as { taxWithholdings?: RetencionGuardada[] | null }).taxWithholdings ?? []).filter(
      (r) => Number(r.importe) > 0
    );
  const codigos = codigosDeRetencion();
  const sinCodigo = retenciones.filter((r) => !codigos.has(r.impuesto));

  if (sinCodigo.length > 0) {
    const cuales = [...new Set(sinCodigo.map((r) => nombreImpuesto(r.impuesto)))].join(" y ");
    throw new RegistroSapError(
      "RETENCIONES",
      `${folio} retiene ${cuales} y Business One no sabe con qué código registrarlo. Registrarla así la dejaría por su importe bruto, y el pago le entregaría al proveedor lo que ya se le retuvo para el SAT. Configura RETENCIONES_WT_CODES con los códigos de retención de KPS (por ejemplo "002:IVA_RET_4,001:ISR_RET_10") o registra esta factura a mano en Business One.`
    );
  }

  // `baseEntry` es el DocEntry de la ENTRADA de mercancía: el BaseEntry del
  // payload. Sin él no hay DocumentLines que mandar y B1 rechaza el POST.
  const entradaDocEntry = (f as { baseEntry?: number | null }).baseEntry ?? null;
  if (!entradaDocEntry) {
    throw new RegistroSapError(
      "SIN_ENTRADA",
      `${folio} no dice contra qué entrada de mercancía se factura. En Business One la factura se copia de la entrada, no de la orden, así que sin ese dato no se puede registrar.`
    );
  }

  // --- La entrada, leída de B1 --------------------------------------------
  let entrada: EntradaB1 | null = null;
  try {
    entrada = await sapFetch<EntradaB1>(`/PurchaseDeliveryNotes(${entradaDocEntry})`);
  } catch (e) {
    if (e instanceof SapError && e.status === 404) entrada = null;
    else
      throw new RegistroSapError(
        "SAP",
        e instanceof Error ? e.message : "No se pudo consultar Business One."
      );
  }

  if (!entrada) {
    throw new RegistroSapError(
      "ENTRADA_NO_EXISTE",
      `La entrada de mercancía ${entradaDocEntry} ya no existe en Business One.`
    );
  }
  if (entrada.Cancelled === "tYES") {
    throw new RegistroSapError(
      "ENTRADA_CANCELADA",
      `La entrada ${entrada.DocNum} está cancelada en Business One: no entró nada al almacén y no se puede facturar.`
    );
  }
  if (entrada.DocumentStatus !== "bost_Open") {
    throw new RegistroSapError(
      "ENTRADA_CERRADA",
      `La entrada ${entrada.DocNum} ya está cerrada en Business One: alguien la facturó antes.`
    );
  }

  // --- Idempotencia: ¿ya está registrada? ---------------------------------
  let yaEnB1: FacturaB1 | null = null;
  try {
    yaEnB1 = await buscarPorUuid(f.uuid);
  } catch (e) {
    throw new RegistroSapError(
      "SAP",
      e instanceof Error ? e.message : "No se pudo comprobar si la factura ya existe en SAP."
    );
  }

  // --- Los renglones -------------------------------------------------------
  // Sin `Quantity`: B1 factura todo lo abierto del renglón. Es lo correcto para
  // el caso completo y evita que un redondeo nuestro no cuadre con el de B1.
  const entradaLeida = entrada;
  const lineas = (entradaLeida.DocumentLines ?? [])
    .filter((l) => abiertaDe(l) > 0)
    .map((l) => ({
      BaseType: OBJECT_TYPE.entrada,
      BaseEntry: entradaLeida.DocEntry,
      BaseLine: l.LineNum,
    }));

  if (!yaEnB1 && lineas.length === 0) {
    throw new RegistroSapError(
      "SIN_RENGLONES",
      `La entrada ${entradaLeida.DocNum} no tiene ningún renglón pendiente de facturar.`
    );
  }

  // --- Crear (o reusar) ----------------------------------------------------
  let creada: FacturaB1;
  const reusada = yaEnB1 !== null;

  if (yaEnB1) {
    creada = yaEnB1;
  } else {
    try {
      creada = await sapFetch<FacturaB1>("/PurchaseInvoices", {
        method: "POST",
        body: JSON.stringify({
          // De la ENTRADA y no de la factura del portal: aceptarlo del documento
          // local permitiría colgar la factura del proveedor equivocado.
          CardCode: entradaLeida.CardCode,
          DocDate: fechaB1(f.issueDate),
          // NO se manda `DocCurrency`. B1 la hereda de la entrada, igual que
          // hereda precios e impuestos, y mandarla solo puede estropearlo: el
          // CFDI escribe el peso mexicano como `MXN` y la localizacion de B1
          // como `MXP`, asi que copiar la del comprobante devuelve
          // "Invalid currency". Traducir MXN->MXP tampoco vale: seria una tabla
          // de equivalencias que mantener para no ganar nada, porque el dato
          // correcto ya esta en el documento del que se copia.
          // El UUID del CFDI, en el campo de usuario que usa KPS. Es el único
          // identificador duro del documento y lo que hace idempotente el
          // reintento. Ver `CAMPO_UUID` para por qué no va en `NumAtCard`.
          [CAMPO_UUID]: f.uuid,
          // `NumAtCard` NO se manda, y es deliberado.
          //
          // Es la referencia DEL PROVEEDOR, y en la instalación de KPS lleva el
          // FOLIO de la factura del proveedor: 5996, 4485, 63965506. El portal
          // guarda la serie del CFDI (`serie`) pero no su folio —el campo
          // `folio` de `InvoiceDoc` es el consecutivo propio, FAC-2026-007—, así
          // que el dato correcto no lo tenemos. Mandar la serie sola ("A") sería
          // inventar una referencia y ensuciar un campo que KPS sí consulta.
          //
          // PENDIENTE: guardar el `Folio` del CFDI al parsearlo y mandarlo aquí.
          Comments: `Portal KPS · ${folio}`,
          // Las retenciones. Van solo si las hay: un arreglo vacío es
          // equivalente a no mandar el campo, pero mandarlo siempre añade ruido
          // al payload de la inmensa mayoría de facturas, que no retienen nada.
          //
          // `TaxableAmount` es la BASE sobre la que se retuvo, no el total de la
          // factura: en una retención de IVA de 2/3 partes la base es el IVA
          // trasladado, no el subtotal. Los dos importes salen del CFDI, que es
          // quien los declaró ante el SAT.
          ...(retenciones.length > 0
            ? {
                WithholdingTaxDataCollection: retenciones.map((r) => ({
                  WTCode: codigos.get(r.impuesto),
                  TaxableAmount: Number(r.base),
                  WTAmount: Number(r.importe),
                })),
              }
            : {}),
          DocumentLines: lineas,
        }),
      });
    } catch (e) {
      const mensaje =
        e instanceof Error ? e.message : "Business One rechazó la factura y no dijo por qué.";
      // Se deja constancia local del rechazo: sin esto la petición se queda en
      // APROBADA_PAGO sin que nadie sepa que se intentó ni qué contestó SAP.
      await Invoice().updateOne({ folio }, { $set: { sapError: mensaje } });
      throw new RegistroSapError("SAP", mensaje);
    }
  }

  // --- Adjuntos ------------------------------------------------------------
  // Fuera de todo lo demás: la factura ya existe en B1 y un adjunto que falta se
  // vuelve a subir. Presentarlo como "no se registró" sería falso y llevaría a
  // reintentar la creación.
  let attachmentEntry: number | null = null;
  let avisoAdjuntos: string | null = null;
  try {
    attachmentEntry = await adjuntar(creada.DocEntry, folio, {
      xmlFileKey: f.xmlFileKey,
      pdfFileKey: f.pdfFileKey,
    });
  } catch (e) {
    avisoAdjuntos =
      e instanceof Error ? e.message : "No se pudieron adjuntar el XML y el PDF en Business One.";
    console.error(`[registrar-sap] ${folio}: factura creada pero sin adjuntos:`, e);
  }

  // --- Constancia local ----------------------------------------------------
  const ahora = new Date();

  await Invoice().updateOne(
    { folio },
    {
      $set: {
        status: "REGISTRADA_SAP",
        sapDocEntry: creada.DocEntry,
        sapDocNum: creada.DocNum,
        sapAttachmentEntry: attachmentEntry,
        sapPostedAt: ahora,
        sapError: avisoAdjuntos,
        sapDocDueDate: creada.DocDueDate ? new Date(creada.DocDueDate) : null,
        goodsReceiptNumber: String(entradaLeida.DocNum),
      },
    }
  );

  // §11: un evento por cada cambio de estatus. Va fuera de transacción porque
  // esta conexión puede apuntar a un despliegue sin replica set; el riesgo es un
  // evento perdido, no un estatus a medias.
  await InvoiceEvent().create({
    invoiceFolio: folio,
    fromStatus: REGISTRABLE,
    toStatus: "REGISTRADA_SAP",
    actorId,
    actorRole,
    comment: reusada
      ? `La factura ya estaba en Business One como ${creada.DocNum}. Se enlazó sin volver a crearla.`
      : `Factura registrada en Business One como ${creada.DocNum} (DocEntry ${creada.DocEntry}), copiada de la entrada ${entradaLeida.DocNum}.`,
    payload: {
      docEntry: creada.DocEntry,
      docNum: creada.DocNum,
      entradaDocEntry: entradaLeida.DocEntry,
      entradaDocNum: entradaLeida.DocNum,
      uuid: f.uuid,
      reusada,
    },
    createdAt: ahora,
  });

  await AuditLog().create({
    entityType: "invoice",
    entityId: folio,
    action: "FACTURA_REGISTRADA_SAP",
    actorId,
    actorRole,
    before: { status: REGISTRABLE },
    after: { status: "REGISTRADA_SAP", sapDocEntry: creada.DocEntry, sapDocNum: creada.DocNum },
    comment: avisoAdjuntos,
    createdAt: ahora,
  });

  return {
    docEntry: creada.DocEntry,
    docNum: creada.DocNum,
    reusada,
    attachmentEntry,
    avisoAdjuntos,
  };
}
