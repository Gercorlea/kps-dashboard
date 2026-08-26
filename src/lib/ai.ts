import { randomUUID } from "node:crypto";
import { stepCountIs, streamText, tool } from "ai";
import type { ModelMessage } from "ai";
import { z } from "zod";
import { ENTIDADES_SAP, OPERACIONES_AGREGADO, agregarSap, consultarSap } from "@/lib/sap/consultas";
import { COLECCIONES_RETAIL, consultarRetail } from "@/lib/retail/consultas-ia";
import { MODELO_DEFECTO, esModeloValido } from "@/lib/ai-modelos";
import { crearReporte } from "@/lib/reportes/crear-reporte";
import { CONTEXTO_SAP } from "@/lib/sap-contexto.generado";

// Toda llamada a modelos pasa por Vercel AI Gateway (§9.1). Nunca un SDK
// de proveedor directo. Auth con AI_GATEWAY_API_KEY (solo servidor).

const ZONA = "America/Mexico_City";

// El modelo no tiene reloj: si no le damos la fecha, la pregunta o la inventa.
// Se calcula por petición (no al cargar el módulo) para que no se congele en
// el arranque del servidor.
function hoy(): { iso: string; largo: string } {
  const ahora = new Date();
  const iso = new Intl.DateTimeFormat("en-CA", {
    timeZone: ZONA,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(ahora);
  const largo = new Intl.DateTimeFormat("es-MX", {
    timeZone: ZONA,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(ahora);
  return { iso, largo };
}

// La fecha cambia cada día, así que va en un bloque APARTE del prompt
// estático: metida dentro invalidaría el caché de Anthropic cada medianoche
// y volverían a procesarse los ~18,800 tokens de contexto desde cero.
function promptFecha(): string {
  const { iso, largo } = hoy();
  return `Hoy es ${largo} (${iso}), hora de ${ZONA}. Nunca preguntes al usuario qué
día es: resuelve tú "hoy", "ayer", "esta semana", "este mes" o "el año pasado"
a partir de esa fecha y úsala para construir los filtros de tus consultas.`;
}

// Prefijo ESTÁTICO del prompt: se evalúa una sola vez al cargar el módulo, no
// por petición. Es literalmente lo que Anthropic cachea, así que nada que
// varíe entre peticiones (fechas, usuario, modelo) puede entrar aquí.
const PROMPT_ESTATICO = `Eres KPS AI, el asistente conversacional de Arcanum dentro de Cronos Retail.
Respondes siempre en español, de forma clara, directa y profesional.

Consultas datos en vivo de dos fuentes: SAP Business One (Service Layer) y
la base de MongoDB del módulo Retail (ventas, pronósticos, inventarios,
órdenes de compra y cargas). Nunca menciones "la pestaña Retail" como
respuesta: consulta tú los datos con tus tools.
Si no sabes algo, dilo sin inventar.

${CONTEXTO_SAP}

SAP es SOLO LECTURA para ti: ayuda únicamente con consultas (GET / lectura
de datos). Nunca propongas, generes ni guíes operaciones que agreguen,
modifiquen o borren datos en SAP (POST/PATCH/PUT/DELETE); si te lo piden,
explica que la política del proyecto solo permite consultar.

Tienes dos tools de solo lectura: consultar_sap (datos en vivo del
Service Layer) y consultar_retail (colecciones de MongoDB del módulo Retail). Úsala siempre que pregunten por datos concretos (stock, artículos,
socios, órdenes, facturas…) en vez de responder de memoria. Si la consulta
falla, reporta el error tal cual sin inventar datos. Presenta los
resultados en tablas o listas claras y menciona el total cuando aplique.

Si una consulta falla, NO concluyas que el dato es inaccesible: casi siempre
hay otra vía (otra entidad, los campos anidados, las líneas del documento).
Prueba al menos dos antes de rendirte, y solo entonces di que no pudiste.

Nunca nombres funciones, archivos, parámetros ni detalles internos de esta
aplicación al explicarte. Si algo no se pudo consultar, dilo en términos de
negocio ("ese dato no está capturado en SAP"), jamás mencionando el código.

LENGUAJE DE NEGOCIO (regla dura). Quien te lee lleva ventas, compras o
inventario, no sistemas. En tus respuestas NUNCA aparecen nombres de campos
de SAP ni valores codificados: ni en el texto, ni en los encabezados de
tabla, ni en las viñetas, ni dentro de los reportes. Tampoco expliques la
estructura de los datos: nada de "clave primaria", "entidad", "entity set",
"colección", "campo", "OData", "Service Layer", "MongoDB" o "esquema". Si te
preguntan qué información tienes sobre algo, contesta con los conceptos de
negocio en una frase o una lista corta ("de cada proveedor tengo nombre,
teléfono, correo, saldo, moneda y si está activo"), NUNCA con una tabla de
campo/descripción.

Traduce siempre al presentar, y usa la etiqueta en español de encabezado:
- Socios de negocio: CardCode → Código; CardName → Nombre; CardType → Tipo;
  GroupCode → Grupo; Phone1 → Teléfono; EmailAddress → Correo;
  CurrentAccountBalance → Saldo; Currency → Moneda; Valid → Estatus.
- Artículos: ItemCode → Código; ItemName → Artículo; U_Marca → Marca;
  ItemsGroupCode → Grupo; BarCode → Código de barras;
  QuantityOnStock → Existencia; QuantityOrderedFromVendors → Pedido a
  proveedor; QuantityOrderedByCustomers → Comprometido con clientes;
  InventoryUOM → Unidad; UpdateDate → Última actualización.
- Documentos: DocNum → Folio; DocDate → Fecha; DocDueDate → Vencimiento;
  DocTotal → Total; DocCurrency → Moneda; DocumentStatus → Estatus;
  Quantity → Cantidad; Price → Precio unitario; LineTotal → Importe.
- Otros: WarehouseName → Almacén; PriceListName → Lista de precios;
  ValidFrom / ValidTo → Vigencia.
Y los valores codificados: tYES → Activo y tNO → Inactivo; cSupplier o "S" →
Proveedor; cCustomer o "C" → Cliente; cLid → Prospecto; bost_Open → Abierto
y bost_Close → Cerrado; MXP → MXN, y los importes con separador de miles.

Los identificadores internos (DocEntry, LineNum, códigos numéricos de grupo)
no se muestran: usa el folio o el nombre; si solo tienes el código de un
grupo o de un almacén, resuélvelo a su nombre con otra consulta antes de
responder. Los códigos que el usuario sí maneja a diario —el del artículo y
el del socio de negocio— sí se muestran, pero bajo su etiqueta en español.

TOTALES Y RANKINGS (regla dura): TÚ NUNCA CUENTAS NI SUMAS FILAS. Para
"cuánto en total", "cuántos", "el más/menos vendido", "el cliente que más
compró", los totales se piden YA CALCULADOS:
- Sobre documentos de SAP (facturas, pedidos, órdenes): agregar_sap, que
  agrega la historia completa en una llamada.
- Ventas por artículo o por cliente con filtros de fecha: consultar_retail
  con la colección sapSales y agruparPor/sumar (quantity = unidades,
  lineTotal = importe). Cubre todo el histórico de facturas de SAP.
- Cifras del módulo Retail (unidades por marca, etc.): consultar_retail con
  agruparPor/sumar.
Responder un ranking o un total a partir de una muestra de filas está
PROHIBIDO: si por alguna razón solo tienes una muestra (devueltas < total),
dilo explícitamente y NO lo presentes como definitivo.

NUNCA generalices desde una muestra parcial. Cada consulta te devuelve
\`total\` (cuántos registros hay en total) y \`devueltas\` (cuántos viste).

REPORTES. Cuando pidan un reporte, informe, summary exportable o PDF:
1. Consulta primero los datos reales con tus tools. Nunca inventes cifras.
2. Arma el markdown y LLAMA a crear_reporte en ese mismo turno. Nunca
   anuncies que vas a generarlo y termines: si dices que lo generas, la
   llamada a la herramienta va en la misma respuesta.
3. Empieza el markdown con un bloque \`\`\`portada con JSON:
   {"title": "...", "subtitle": "una o dos frases de alcance",
    "metrics": [{"value": "8,931", "unit": "docs", "label": "Facturas"}]}
   Máximo 4 métricas, siempre con números que hayas consultado.
4. El cuerpo va en secciones con ## y los datos SIEMPRE en tablas markdown.
   Alinea a la derecha las columnas numéricas usando ---: en el separador.
5. NO pegues el markdown del reporte en tu respuesta de texto: el usuario lo
   recibe como tarjeta descargable. En el chat solo confirma que está listo y
   di en una o dos frases qué incluye.
El PDF no admite gráficas ni imágenes: solo texto, listas y tablas.
6. Sé selectivo: el reporte se escribe token a token y uno muy largo tarda
   minutos. Tablas con los totales y los primeros 10-20 renglones relevantes,
   no catálogos enteros; el tope duro son 30,000 caracteres.

Estilo de respuesta:
- Nunca uses emojis (ni en texto, ni en encabezados, ni en viñetas).
- No cierres con ofertas de ayuda técnica sobre la integración, el Service
  Layer, la extensión del código o el diagnóstico de errores. Si quieres
  ofrecer un siguiente paso, que sea sobre DATOS del negocio y solo cuando
  aporte algo concreto.
- Ve al grano: la respuesta primero, el detalle después.`;

export interface HerramientaUsada {
  name: string;
  args: unknown;
  result?: unknown;
}

// Qué se guarda de cada llamada. Los argumentos siempre (son la traza de qué
// se consultó); el resultado completo SOLO de crear_reporte, porque es el
// contenido que hay que poder recuperar al recargar. Guardar también las
// filas de cada consulta haría que una conversación pesara megas.
function resumirHerramientas(
  pasos: ReadonlyArray<{
    toolCalls?: ReadonlyArray<{ toolName: string; input?: unknown }>;
    toolResults?: ReadonlyArray<{ toolName: string; output?: unknown }>;
  }>
): HerramientaUsada[] {
  const usadas: HerramientaUsada[] = [];
  for (const paso of pasos) {
    const llamadas = paso.toolCalls ?? [];
    const resultados = paso.toolResults ?? [];
    llamadas.forEach((llamada, i) => {
      const salida = resultados[i]?.output;
      let result: unknown;
      if (llamada.toolName === "crear_reporte") {
        result = salida;
      } else if (salida && typeof salida === "object") {
        const r = salida as { devueltas?: number; total?: number; error?: string };
        result = { devueltas: r.devueltas, total: r.total, error: r.error };
      }
      usadas.push({ name: llamada.toolName, args: llamada.input, result });
    });
  }
  return usadas;
}

export function chat(
  messages: ModelMessage[],
  opciones?: {
    model?: string;
    onFinish?: (datos: {
      texto: string;
      model: string;
      entrada: number;
      salida: number;
      cache: { leidos: number; escritos: number };
      tools: HerramientaUsada[];
    }) => Promise<void> | void;
  }
) {
  // Solo modelos de la whitelist (lib/ai-modelos.ts); otro valor cae al default.
  const model = esModeloValido(opciones?.model) ? opciones.model : MODELO_DEFECTO;
  return streamText({
    model: model, // formato creator/model-name (default: anthropic/claude-sonnet-4.6)
    // El sistema va como mensaje (no como `system`) para poder marcarle
    // cacheControl: Anthropic cachea el prefijo estático (~18,800 tokens de
    // contexto SAP) y cada paso de la conversación paga solo lo nuevo. La
    // fecha —que cambia a diario— va DESPUÉS del punto de corte del caché.
    allowSystemInMessages: true,
    messages: [
      {
        role: "system",
        content: PROMPT_ESTATICO,
        providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
      },
      { role: "system", content: promptFecha() },
      ...messages,
    ],
    tools: {
      consultar_sap: tool({
        description:
          "Consulta datos EN VIVO del SAP Business One vía Service Layer (OData, SOLO lectura). " +
          "Acepta CUALQUIER entity set del Service Layer, no solo los comunes " +
          `(${ENTIDADES_SAP.join(", ")}); si necesitas otro, úsalo por su nombre. ` +
          "Devuelve filas y el conteo total. Usa $filter OData en `filtro` " +
          "(ej: \"ItemCode eq '70006147'\" o \"contains(ItemName,'GOLI')\"). " +
          "Si omites `campos` se devuelven los campos clave de la entidad.",
        inputSchema: z.object({
          entidad: z
            .string()
            .max(60)
            .describe("Entity set del Service Layer, ej: Items, Orders, ChartOfAccounts"),
          filtro: z.string().max(500).optional().describe("$filter OData opcional"),
          campos: z
            .array(z.string().max(60))
            .max(15)
            .optional()
            .describe("Campos a devolver ($select); pide solo los necesarios"),
          ordenarPor: z.string().max(80).optional().describe("$orderby, ej: 'DocDate desc'"),
          top: z.number().int().min(1).max(100).optional().describe("Máx. filas (tope 100)"),
          saltar: z
            .number()
            .int()
            .min(0)
            .optional()
            .describe("$skip: para recorrer todo un catálogo en varias llamadas"),
        }),
        execute: async (consulta) => {
          try {
            return await consultarSap(consulta);
          } catch (e) {
            return { error: e instanceof Error ? e.message : "Error consultando SAP" };
          }
        },
      }),
      agregar_sap: tool({
        description:
          "Totales, conteos, promedios y rankings calculados por SAP sobre TODA la " +
          "historia de un entity set (no una muestra). Úsala SIEMPRE que pregunten " +
          "'cuánto en total', 'cuántos', 'el que más/menos' sobre documentos: es una " +
          "sola llamada y cubre los 8,900+ documentos. Solo campos de CABECERA " +
          "(DocTotal, CardCode, DocDate…); NO acepta filtros: agrega la historia " +
          "completa. Para ventas POR ARTÍCULO usa consultar_retail con la colección " +
          "sapSales (agruparPor itemCode, sumar quantity o lineTotal).",
        inputSchema: z.object({
          entidad: z
            .string()
            .max(60)
            .describe("Entity set de documentos, ej: Invoices, Orders, PurchaseOrders"),
          agruparPor: z
            .array(z.string().max(60))
            .max(3)
            .optional()
            .describe("Campos de cabecera por los que agrupar; omite para un total global"),
          metricas: z
            .array(
              z.object({
                campo: z.string().max(60).describe("Campo numérico de cabecera, ej: DocTotal"),
                operacion: z.enum(OPERACIONES_AGREGADO),
              })
            )
            .max(3)
            .optional()
            .describe("Qué calcular por grupo; el conteo de documentos va incluido siempre"),
          top: z
            .number()
            .int()
            .min(1)
            .max(100)
            .optional()
            .describe("Grupos a devolver, ordenados de mayor a menor (defecto 20)"),
        }),
        execute: async (consulta) => {
          try {
            return await agregarSap(consulta);
          } catch (e) {
            return { error: e instanceof Error ? e.message : "Error agregando en SAP" };
          }
        },
      }),
      consultar_retail: tool({
        description:
          "Consulta datos EN VIVO del módulo Retail en MongoDB (SOLO lectura): ventas diarias, " +
          "pronósticos, forecast, stock de CEDIS y farmacias, órdenes de compra y cargas. " +
          "Incluye sapSales: TODAS las líneas de factura de SAP (histórico completo, " +
          "campos itemCode, description, cardName, docDate, quantity, price, lineTotal). " +
          "Usa `agruparPor` + `sumar` para totales exactos sobre todo el histórico " +
          "(ej: el artículo más vendido = sapSales agrupado por itemCode sumando quantity).",
        inputSchema: z.object({
          coleccion: z.enum(COLECCIONES_RETAIL).describe("Colección a consultar"),
          filtros: z
            .array(
              z.object({
                field: z.string().max(40),
                operador: z.enum(["igual", "contiene", "mayorQue", "menorQue"]),
                value: z.union([z.string().max(120), z.number()]),
              })
            )
            .max(6)
            .optional()
            .describe("Filtros; las fechas van como YYYY-MM-DD"),
          agruparPor: z.string().max(40).optional().describe("Campo por el que agrupar"),
          sumar: z.string().max(40).optional().describe("Campo numérico a sumar al agrupar"),
          ordenarPor: z.string().max(40).optional(),
          dir: z.enum(["asc", "desc"]).optional(),
          limite: z.number().int().min(1).max(50).optional(),
        }),
        execute: async (consulta) => {
          try {
            return await consultarRetail(consulta);
          } catch (e) {
            return { error: e instanceof Error ? e.message : "Error consultando Retail" };
          }
        },
      }),
      crear_reporte: tool({
        description:
          "Genera un reporte descargable en PDF a partir de markdown. Úsala cuando pidan " +
          "un reporte, informe, resumen exportable o PDF. Primero consulta los datos; " +
          "luego arma el markdown con portada, secciones y TABLAS. No admite gráficas. " +
          "No repitas el markdown en tu respuesta: el usuario lo descarga desde la tarjeta.",
        inputSchema: z.object({
          title: z.string().min(3).max(120).describe("Título del reporte"),
          markdown: z
            .string()
            .min(40)
            .max(30_000)
            .describe("Cuerpo del reporte: bloque ```portada, secciones ## y tablas"),
          fileName: z.string().max(80).optional().describe("Nombre de archivo sin extensión"),
          summary: z.string().max(300).optional().describe("Una frase de qué contiene"),
        }),
        execute: async (entrada) => crearReporte(entrada, `rep_${randomUUID().slice(0, 12)}`),
      }),
    },
    stopWhen: stepCountIs(10), // encadenar varias consultas antes de responder
    providerOptions: {
      gateway: {
        only: ["anthropic"], // fija el proveedor: sin fallback silencioso
        zeroDataRetention: true, // exige enrutar solo a proveedores con acuerdo ZDR
      },
    },
    onFinish: async ({ text, totalUsage, steps }) => {
      // totalUsage suma todos los pasos (cada tool call es una llamada más).
      // El desglose de caché viaja aparte: esos tokens cuestan 10% (leídos)
      // o 125% (escritos) del precio pleno y costUSD lo necesita saber.
      await opciones?.onFinish?.({
        texto: text,
        model,
        entrada: totalUsage?.inputTokens ?? 0,
        salida: totalUsage?.outputTokens ?? 0,
        cache: {
          leidos: totalUsage?.inputTokenDetails?.cacheReadTokens ?? 0,
          escritos: totalUsage?.inputTokenDetails?.cacheWriteTokens ?? 0,
        },
        tools: resumirHerramientas(steps ?? []),
      });
    },
  });
}
