// Batería de regresión de KPS AI: hace preguntas reales al chat y compara cada
// respuesta contra la verdad calculada AQUÍ, consultando Mongo y SAP directo.
//
// Existe porque probar a mano no escala: cada arreglo parecía bueno con seis
// preguntas escogidas por quien lo arregló, y el siguiente fallo lo encontraba
// el usuario usándolo. Los casos de abajo son los que ya fallaron alguna vez
// más el cruce sistemático de cinco ejes: fuente (Retail / SAP / colecciones
// vacías), entidad (retailer, marca, producto, socio, factura), operación
// (total, contar distintos, ranking, comparar, detalle), forma de preguntar
// (completa, seguimiento corto, con presión, con errata) y trampa del dato
// (canceladas, folio no cronológico, carga en bloque, doble alta, cobertura
// parcial).
//
//   npm run qa:ia              # todo
//   npm run qa:ia -- socios    # sólo los casos cuyo id o eje contenga "socios"
//
// La verdad NO se cablea: se recalcula en cada corrida, así que la batería
// sigue siendo válida cuando entren datos nuevos.
import mongoose from "mongoose";
import { agregarSap, buscarSocios, consultarSap } from "@/lib/sap/consultas";

const BASE = process.env.QA_BASE ?? "http://localhost:3000";
const EMAIL = process.env.QA_EMAIL ?? "admin@kps.com";
const PASSWORD = process.env.QA_PASSWORD ?? "12345678";
const MODELO = process.env.QA_MODELO ?? "anthropic/claude-haiku-4.5";
/** El endpoint permite 30 peticiones cada 5 min: 11 s entre turnos va sobrado. */
const PAUSA_MS = Number(process.env.QA_PAUSA ?? 11_000);

// ---------------------------------------------------------------------------
// Comparación
// ---------------------------------------------------------------------------

/**
 * Quita los separadores de millar para poder buscar la cifra tal cual: el
 * modelo escribe "94,514,110.47" y aquí tenemos 94514110.47.
 */
function normalizar(texto: string): string {
  return texto.replace(/(\d)[,  ](?=\d{3}\b)/g, "$1");
}

/** ¿Aparece esta cifra en la respuesta, con o sin decimales? */
function contieneNumero(texto: string, n: number): boolean {
  const plano = normalizar(texto);
  return plano.includes(String(n)) || plano.includes(String(Math.round(n))) || plano.includes(n.toFixed(2));
}

function contieneTexto(texto: string, s: string): boolean {
  const limpia = (x: string) =>
    x
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toUpperCase();
  return limpia(texto).includes(limpia(s));
}

interface Esperado {
  /** Cifras y textos que TIENEN que aparecer en la última respuesta. */
  debe: Array<number | string>;
  /** Valores equivocados conocidos: si aparecen, el caso falla. */
  noDebe?: Array<number | string>;
}

function evaluar(respuesta: string, esperado: Esperado): string[] {
  const fallos: string[] = [];
  const pinta = (v: number | string) => (typeof v === "number" ? v.toLocaleString("en-US") : `"${v}"`);
  for (const v of esperado.debe) {
    const ok = typeof v === "number" ? contieneNumero(respuesta, v) : contieneTexto(respuesta, v);
    if (!ok) fallos.push(`falta ${pinta(v)}`);
  }
  for (const v of esperado.noDebe ?? []) {
    const mal = typeof v === "number" ? contieneNumero(respuesta, v) : contieneTexto(respuesta, v);
    if (mal) fallos.push(`aparece lo que NO debía: ${pinta(v)}`);
  }
  return fallos;
}

// ---------------------------------------------------------------------------
// Verdad de referencia (Mongo + SAP en vivo)
// ---------------------------------------------------------------------------

type Doc = Record<string, unknown>;

function ventas() {
  return mongoose.connection.collection("salesreports");
}

async function sumaRetail(match: Doc): Promise<{ importe: number; unidades: number; registros: number }> {
  const r = await ventas()
    .aggregate([
      { $match: match },
      {
        $group: {
          _id: null,
          importe: { $sum: "$posSales" },
          unidades: { $sum: "$posQty" },
          registros: { $sum: 1 },
        },
      },
    ])
    .toArray();
  return r.length
    ? { importe: r[0].importe as number, unidades: r[0].unidades as number, registros: r[0].registros as number }
    : { importe: 0, unidades: 0, registros: 0 };
}

async function distintos(campo: string, match: Doc): Promise<string[]> {
  return (await ventas().distinct(campo, match)) as string[];
}

async function topRetail(
  campo: string,
  match: Doc,
  metrica: "posSales" | "posQty"
): Promise<Array<{ clave: string; valor: number }>> {
  const r = await ventas()
    .aggregate([
      { $match: match },
      { $group: { _id: `$${campo}`, v: { $sum: `$${metrica}` } } },
      { $sort: { v: -1 } },
    ])
    .toArray();
  return r.map((x) => ({ clave: String(x._id), valor: x.v as number }));
}

const entre = (ini: string, fin: string) => ({ $gte: new Date(ini), $lte: new Date(fin) });

async function sapAgrega(filtro: string): Promise<{ importe: number; documentos: number }> {
  const r = (await agregarSap({
    entidad: "Invoices",
    filtro,
    metricas: [{ campo: "DocTotal", operacion: "suma" }],
  } as never)) as { filas: Array<Record<string, number>> };
  const f = r.filas[0] ?? {};
  return { importe: Number(f.suma_DocTotal ?? 0), documentos: Number(f.documentos ?? 0) };
}

async function sapTop(): Promise<{ cliente: string; importe: number }> {
  const r = (await agregarSap({
    entidad: "Invoices",
    agruparPor: ["CardName"],
    metricas: [{ campo: "DocTotal", operacion: "suma" }],
    top: 1,
  } as never)) as { filas: Array<Record<string, unknown>>; totalGeneral?: Record<string, number> };
  return { cliente: String(r.filas[0].CardName), importe: Number(r.filas[0].suma_DocTotal) };
}

async function sapFila(filtro: string, campos: string[], ordenarPor?: string): Promise<Doc> {
  const r = (await consultarSap({ entidad: "Invoices", filtro, campos, ordenarPor, top: 1 } as never)) as {
    filas: Doc[];
  };
  return r.filas[0] ?? {};
}

/**
 * Días COMPLETOS que lleva vencida una factura, calculados aquí y no por el
 * modelo. Se comparan fechas a pelo (sin horas): redondear la fracción del día
 * en curso daba 41 donde del 25-jul al 3-sep hay 40, y hacía fallar a la IA
 * por un error de la propia batería.
 */
function diasVencida(vence: string, hoy = new Date()): number {
  const soloFecha = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return Math.floor((soloFecha(hoy) - soloFecha(new Date(vence))) / 86_400_000);
}

// ---------------------------------------------------------------------------
// Casos
// ---------------------------------------------------------------------------

interface Caso {
  id: string;
  eje: string;
  /** Conversación completa; se evalúa la respuesta al ÚLTIMO turno. */
  turnos: string[];
  esperado: () => Promise<Esperado>;
}

const CASOS: Caso[] = [
  // --- Retail: totales -----------------------------------------------------
  {
    id: "total-walmart",
    eje: "retail/total",
    turnos: ["cual es el importe total de ventas de walmart"],
    esperado: async () => ({ debe: [(await sumaRetail({ account: "walmart" })).importe] }),
  },
  {
    id: "total-todos",
    eje: "retail/total",
    turnos: ["dame el importe total de todos los retailers"],
    esperado: async () => {
      const w = await sumaRetail({ account: "walmart" });
      const s = await sumaRetail({ account: "san-pablo" });
      return { debe: [w.importe, s.importe] };
    },
  },
  {
    id: "unidades-walmart",
    eje: "retail/total",
    turnos: ["cuantas unidades ha vendido walmart en total"],
    esperado: async () => ({ debe: [(await sumaRetail({ account: "walmart" })).unidades] }),
  },

  // --- Retail: contar valores distintos ------------------------------------
  {
    id: "cuantos-productos-walmart",
    eje: "retail/contar",
    turnos: ["cuantos articulos vende walmart?"],
    esperado: async () => ({ debe: [(await distintos("itemDesc", { account: "walmart" })).length] }),
  },
  {
    id: "cuantos-productos-sanpablo",
    eje: "retail/contar",
    turnos: ["cuantos articulos vende san pablo?"],
    esperado: async () => ({ debe: [(await distintos("itemDesc", { account: "san-pablo" })).length] }),
  },
  {
    id: "cuantas-marcas-sanpablo",
    eje: "retail/contar",
    turnos: ["cuantas marcas maneja san pablo?"],
    esperado: async () => ({ debe: [(await distintos("brand", { account: "san-pablo" })).length] }),
  },
  {
    id: "cuantos-productos-marca",
    eje: "retail/contar",
    turnos: ["cuantos productos de la marca vita vibe vende san pablo?"],
    esperado: async () => ({
      debe: [(await distintos("itemDesc", { account: "san-pablo", brand: "VITA VIBE" })).length],
    }),
  },
  {
    id: "cuantos-productos-multiblue",
    eje: "retail/contar",
    turnos: ["cuantos productos de la marca multiblue vende walmart?"],
    esperado: async () => ({
      debe: [(await distintos("itemDesc", { account: "walmart", brand: "MULTIBLUE" })).length],
    }),
  },

  // --- Retail: marca escrita de cualquier forma ----------------------------
  {
    id: "marca-minusculas",
    eje: "retail/escritura",
    turnos: ["dame el importe total de spring valley en walmart"],
    esperado: async () => ({ debe: [(await sumaRetail({ account: "walmart", brand: "SPRING VALLEY" })).importe] }),
  },
  {
    id: "marca-errata",
    eje: "retail/escritura",
    turnos: ["dame el importe total de multilbue en walmart"],
    esperado: async () => ({ debe: [(await sumaRetail({ account: "walmart", brand: "MULTIBLUE" })).importe] }),
  },
  {
    id: "marca-capitalizada",
    eje: "retail/escritura",
    turnos: ["dame el importe total de la marca Bloom en walmart"],
    esperado: async () => ({ debe: [(await sumaRetail({ account: "walmart", brand: "BLOOM" })).importe] }),
  },
  {
    id: "marca-inexistente",
    eje: "retail/escritura",
    turnos: ["dame el importe total de la marca xyzabc en walmart"],
    esperado: async () => ({ debe: ["no"] }),
  },

  // --- Retail: productos ---------------------------------------------------
  {
    id: "producto-mas-vendido",
    eje: "retail/producto",
    turnos: ["cual es el producto mas vendido de walmart en unidades?"],
    esperado: async () => {
      const t = await topRetail("itemDesc", { account: "walmart" }, "posQty");
      return { debe: [t[0].clave, t[0].valor] };
    },
  },
  {
    id: "producto-importe",
    eje: "retail/producto",
    turnos: ["cual es el importe total de bloom frutos rojos en walmart?"],
    esperado: async () => ({
      debe: [(await sumaRetail({ account: "walmart", itemDesc: "BLOOM FRUTOS ROJOS" })).importe],
    }),
  },
  {
    id: "producto-relax",
    eje: "retail/producto",
    turnos: ["cuales son las ventas netas de multiblue relax?"],
    esperado: async () => ({
      debe: [(await sumaRetail({ account: "walmart", itemDesc: "MULTIBLUE RELAX" })).importe],
    }),
  },
  {
    id: "producto-top-de-marca",
    eje: "retail/producto",
    turnos: ["cual es el producto mas vendido de bloom en san pablo y cuantas unidades?"],
    esperado: async () => {
      const t = await topRetail("itemDesc", { account: "san-pablo", brand: "BLOOM" }, "posQty");
      return { debe: [t[0].clave, t[0].valor] };
    },
  },

  // --- Retail: periodos ----------------------------------------------------
  {
    id: "mes-concreto",
    eje: "retail/periodo",
    turnos: ["dame las ventas de walmart de enero 2026"],
    esperado: async () => ({
      debe: [(await sumaRetail({ account: "walmart", date: entre("2026-01-01", "2026-01-31") })).importe],
    }),
  },
  {
    id: "mes-pico",
    eje: "retail/periodo",
    turnos: ["cual es el mes con mas ventas de walmart en todo el historico?"],
    esperado: async () => {
      const filas = await ventas()
        .aggregate([
          { $match: { account: "walmart" } },
          { $group: { _id: { $dateToString: { date: "$date", format: "%Y-%m" } }, v: { $sum: "$posSales" } } },
          { $sort: { v: -1 } },
          { $limit: 1 },
        ])
        .toArray();
      return { debe: [filas[0].v as number] };
    },
  },
  {
    id: "dia-pico",
    eje: "retail/periodo",
    turnos: ["cual fue el dia con mas ventas de walmart en enero 2026?"],
    esperado: async () => {
      const filas = await ventas()
        .aggregate([
          { $match: { account: "walmart", date: entre("2026-01-01", "2026-01-31") } },
          { $group: { _id: { $dateToString: { date: "$date", format: "%Y-%m-%d" } }, v: { $sum: "$posSales" } } },
          { $sort: { v: -1 } },
          { $limit: 1 },
        ])
        .toArray();
      return { debe: [filas[0].v as number] };
    },
  },

  // --- SAP: socios ---------------------------------------------------------
  {
    id: "socio-doble",
    eje: "sap/socios",
    turnos: ["liverpool es cliente o proveedor?"],
    esperado: async () => {
      const r = await buscarSocios("liverpool");
      return { debe: r.socios.map((s) => String((s as Doc).CardCode)) };
    },
  },
  {
    id: "socio-errata",
    eje: "sap/socios",
    turnos: ["le vendemos a copel?"],
    esperado: async () => {
      const r = await buscarSocios("coppel");
      return { debe: [String((r.socios[0] as Doc).CardCode)] };
    },
  },
  {
    id: "socio-con-espacio",
    eje: "sap/socios",
    turnos: ["walmart esta dado de alta como cliente en sap?"],
    esperado: async () => {
      const r = await buscarSocios("walmart");
      return { debe: r.socios.map((s) => String((s as Doc).CardCode)) };
    },
  },
  {
    id: "socio-inexistente",
    eje: "sap/socios",
    turnos: ["le vendemos a chedraui?"],
    esperado: async () => ({ debe: ["no"] }),
  },
  {
    // El signo del saldo se leía al revés: se llegó a decir que KPS le debía a
    // Walmart cuando es Walmart quien debe 21.8 M.
    id: "saldo-quien-debe",
    eje: "sap/socios",
    turnos: ["cual es el saldo de walmart? quien le debe a quien?"],
    esperado: async () => {
      const r = await buscarSocios("walmart");
      const cliente = r.socios.find((s) => (s as Doc).CardType === "cCustomer") as Doc;
      return {
        debe: [Math.abs(Number(cliente.CurrentAccountBalance)), "debe"],
        noDebe: ["KPS le debe", "KPS debe", "a favor de walmart"],
      };
    },
  },

  // --- SAP: facturas y sus trampas ----------------------------------------
  {
    id: "facturado-sin-canceladas",
    eje: "sap/facturas",
    turnos: ["cuanto le hemos facturado a coppel en total?"],
    esperado: async () => {
      const vivas = await sapAgrega("CardCode eq 'C000140'");
      const canceladas = await sapAgrega("CardCode eq 'C000140' and Cancelled eq 'tYES'");
      return { debe: [vivas.importe], noDebe: [vivas.importe + canceladas.importe] };
    },
  },
  {
    id: "canceladas-total",
    eje: "sap/facturas",
    turnos: ["cuantas facturas canceladas hay y por cuanto importe?"],
    esperado: async () => {
      const c = await sapAgrega("Cancelled eq 'tYES'");
      return { debe: [c.documentos, c.importe] };
    },
  },
  {
    id: "ultimas-facturas",
    eje: "sap/facturas",
    turnos: ["dame las ultimas 5 facturas registradas"],
    esperado: async () => {
      const f = await sapFila("DocTotal ne 0", ["DocNum", "DocDate", "CardName"], "DocDate desc");
      return { debe: [Number(f.DocNum), String(f.CardName)] };
    },
  },
  {
    id: "facturas-de-un-mes",
    eje: "sap/facturas",
    turnos: ["cuantas facturas se registraron en junio de 2026?"],
    esperado: async () => ({
      debe: [(await sapAgrega("DocDate ge '2026-06-01' and DocDate le '2026-06-30'")).documentos],
    }),
  },
  {
    id: "cliente-mayor",
    eje: "sap/facturas",
    turnos: ["cual es el cliente que mas nos compra y por cuanto?"],
    esperado: async () => {
      const t = await sapTop();
      return { debe: [t.cliente, t.importe] };
    },
  },
  {
    id: "dias-vencida",
    eje: "sap/facturas",
    turnos: ["la factura 5290 esta vencida? cuantos dias lleva"],
    esperado: async () => {
      const f = await sapFila("DocNum eq 5290", ["DocNum", "DocDueDate"]);
      return { debe: [diasVencida(String(f.DocDueDate))] };
    },
  },

  // --- Colecciones sin datos ----------------------------------------------
  {
    id: "sin-datos-lotes",
    eje: "vacios",
    turnos: ["cuales son los lotes mas vendidos?"],
    esperado: async () => ({ debe: ["sincroniz"] }),
  },
  {
    id: "sin-datos-cedis",
    eje: "vacios",
    turnos: ["dame el inventario en CEDIS de walmart"],
    esperado: async () => ({ debe: ["no"] }),
  },

  // --- Seguimientos: donde más se inventaba -------------------------------
  {
    id: "seguimiento-otro-mes",
    eje: "seguimiento",
    turnos: ["dame las ventas de walmart de enero 2026", "y de febrero?"],
    esperado: async () => {
      const feb = await sumaRetail({ account: "walmart", date: entre("2026-02-01", "2026-02-28") });
      return { debe: [feb.importe] };
    },
  },
  {
    id: "seguimiento-otra-metrica",
    eje: "seguimiento",
    turnos: ["cual es la marca que mas ganancias ha generado en walmart?", "dame las unidades vendidas de cada una"],
    esperado: async () => {
      const t = await topRetail("brand", { account: "walmart" }, "posQty");
      return { debe: t.map((x) => x.valor) };
    },
  },
  {
    id: "seguimiento-corto",
    eje: "seguimiento",
    turnos: ["cuantos productos de la marca bloom vende san pablo?", "desglosalo"],
    esperado: async () => {
      const t = await topRetail("itemDesc", { account: "san-pablo", brand: "BLOOM" }, "posQty");
      return { debe: [t[0].clave, t[0].valor] };
    },
  },

  // --- Presión: decirle que está mal --------------------------------------
  {
    id: "presion-mantiene-cifra",
    eje: "presion",
    turnos: ["dame el importe total de spring valley en walmart", "vuelve a revisarlo", "esta mal el importe total"],
    esperado: async () => ({ debe: [(await sumaRetail({ account: "walmart", brand: "SPRING VALLEY" })).importe] }),
  },
  {
    id: "presion-no-recorta-lista",
    eje: "presion",
    turnos: ["cuantos productos de la marca vita vibe vende san pablo?", "vuelve a revisarlo"],
    esperado: async () => ({
      debe: [(await distintos("itemDesc", { account: "san-pablo", brand: "VITA VIBE" })).length],
    }),
  },

  // --- Conversacional: no debe disparar consultas inútiles ----------------
  {
    id: "saludo",
    eje: "conversacional",
    turnos: ["hola"],
    esperado: async () => ({ debe: ["hola"] }),
  },
];

// ---------------------------------------------------------------------------
// Cliente del chat
// ---------------------------------------------------------------------------

let cookie = "";

async function login(): Promise<void> {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!r.ok) throw new Error(`Login falló (${r.status}). ¿Está levantado ${BASE}?`);
  cookie = (r.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  if (!cookie) throw new Error("El login no devolvió cookie de sesión.");
}

async function nuevoChat(titulo: string): Promise<string> {
  const r = await fetch(`${BASE}/api/ai/chats`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ title: titulo }),
  });
  const j = (await r.json()) as { data?: { id: string } };
  if (!j.data?.id) throw new Error(`No se pudo crear la conversación: ${JSON.stringify(j).slice(0, 200)}`);
  return j.data.id;
}

interface Parte {
  type: string;
  text?: string;
}
interface Mensaje {
  id: string;
  role: string;
  parts: Parte[];
}

/** Lee el stream SSE y devuelve el texto y qué tools se usaron. */
async function preguntar(chatId: string, historial: Mensaje[]): Promise<{ texto: string; tools: string[] }> {
  const r = await fetch(`${BASE}/api/ai/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ chatId, model: MODELO, messages: historial }),
  });
  const bruto = await r.text();
  const texto: string[] = [];
  const tools: string[] = [];
  for (const linea of bruto.split("\n")) {
    if (!linea.startsWith("data:")) continue;
    const carga = linea.slice(5).trim();
    if (!carga || carga === "[DONE]") continue;
    try {
      const ev = JSON.parse(carga) as { type?: string; delta?: string; toolName?: string };
      if (ev.type === "text-delta" && ev.delta) texto.push(ev.delta);
      else if (ev.type === "tool-input-available" && ev.toolName) tools.push(ev.toolName);
    } catch {
      // línea de control que no es JSON: se ignora
    }
  }
  return { texto: texto.join(""), tools };
}

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Ejecución
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const filtro = process.argv.slice(2).find((a) => !a.startsWith("-"));
  const casos = filtro ? CASOS.filter((c) => c.id.includes(filtro) || c.eje.includes(filtro)) : CASOS;
  if (!casos.length) {
    console.error(`Ningún caso coincide con "${filtro}".`);
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI as string);
  await login();

  const turnos = casos.reduce((s, c) => s + c.turnos.length, 0);
  console.log(`Batería de KPS AI — ${casos.length} casos, ${turnos} turnos contra ${BASE}`);
  console.log(`Modelo: ${MODELO} · ~${Math.ceil((turnos * PAUSA_MS) / 60_000)} min\n`);

  const fallidos: Array<{ caso: Caso; motivos: string[]; respuesta: string }> = [];
  let n = 0;

  for (const caso of casos) {
    n++;
    const esperado = await caso.esperado();
    const chatId = await nuevoChat(`QA ${caso.id}`);
    const historial: Mensaje[] = [];
    let ultima = { texto: "", tools: [] as string[] };

    for (const pregunta of caso.turnos) {
      historial.push({ id: `u${historial.length}`, role: "user", parts: [{ type: "text", text: pregunta }] });
      ultima = await preguntar(chatId, historial);
      historial.push({ id: `a${historial.length}`, role: "assistant", parts: [{ type: "text", text: ultima.texto }] });
      await dormir(PAUSA_MS);
    }

    const motivos = evaluar(ultima.texto, esperado);
    // Toda pregunta sobre datos tiene que haber consultado algo. La única
    // excepción es el caso conversacional, que precisamente NO debe consultar.
    if (caso.eje !== "conversacional" && !ultima.tools.length) {
      motivos.push("respondió SIN llamar a ninguna herramienta");
    }
    if (caso.eje === "conversacional" && ultima.tools.length) {
      motivos.push(`consultó sin necesidad: ${ultima.tools.join(", ")}`);
    }

    const etiqueta = `[${String(n).padStart(2)}/${casos.length}] ${caso.eje.padEnd(18)} ${caso.id}`;
    if (motivos.length) {
      fallidos.push({ caso, motivos, respuesta: ultima.texto });
      console.log(`x ${etiqueta}\n     ${motivos.join("\n     ")}`);
    } else {
      console.log(`. ${etiqueta}`);
    }
  }

  console.log(`\n${casos.length - fallidos.length}/${casos.length} correctos`);
  if (fallidos.length) {
    console.log(`\n${"-".repeat(70)}\nFALLOS\n`);
    for (const f of fallidos) {
      console.log(`- ${f.caso.id} — ${f.caso.turnos.join(" > ")}`);
      for (const m of f.motivos) console.log(`    ${m}`);
      console.log(`    respuesta: ${f.respuesta.replace(/\s+/g, " ").slice(0, 220)}\n`);
    }
  }

  await mongoose.disconnect();
  process.exit(fallidos.length ? 1 : 0);
}

main().catch((e) => {
  console.error("La batería no pudo terminar:", e instanceof Error ? e.message : e);
  process.exit(1);
});
