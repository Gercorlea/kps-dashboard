import { randomUUID } from "node:crypto";
import { stepCountIs, streamText, tool } from "ai";
import type { ModelMessage } from "ai";
import { z } from "zod";
import { ENTIDADES_SAP, consultarSap } from "@/lib/sap/consultas";
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

function sistemaPrompt(): string {
  const { iso, largo } = hoy();
  return `Eres KPS AI, el asistente conversacional de Arcanum dentro de Cronos Retail.
Respondes siempre en español, de forma clara, directa y profesional.

Hoy es ${largo} (${iso}), hora de ${ZONA}. Nunca preguntes al usuario qué día
es: resuelve tú "hoy", "ayer", "esta semana", "este mes" o "el año pasado" a
partir de esa date y úsala para construir los filtros de tus consultas.
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

NUNCA generalices desde una muestra parcial. Cada consulta te devuelve
\`total\` (cuántos registros hay en total) y \`devueltas\` (cuántos viste). Si
\`devueltas\` es menor que \`total\`, todavía NO conoces la respuesta: usa
\`saltar\` para recorrer el resto, o filtra para que el propio SAP cuente. Si
aun así no puedes cubrirlo todo, di explícitamente sobre cuántos registros
estás hablando en vez de presentar el result como definitivo.

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

Estilo de respuesta:
- Nunca uses emojis (ni en texto, ni en encabezados, ni en viñetas).
- No cierres con ofertas de ayuda técnica sobre la integración, el Service
  Layer, la extensión del código o el diagnóstico de errores. Si quieres
  ofrecer un siguiente paso, que sea sobre DATOS del negocio y solo cuando
  aporte algo concreto.
- Ve al grano: la respuesta primero, el detalle después.`;
}

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
      tools: HerramientaUsada[];
    }) => Promise<void> | void;
  }
) {
  // Solo modelos de la whitelist (lib/ai-modelos.ts); otro valor cae al default.
  const model = esModeloValido(opciones?.model) ? opciones.model : MODELO_DEFECTO;
  return streamText({
    model: model, // formato creator/model-name (default: anthropic/claude-sonnet-4.6)
    system: sistemaPrompt(), // incluye la fecha de hoy: se evalúa por petición
    messages,
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
      consultar_retail: tool({
        description:
          "Consulta datos EN VIVO del módulo Retail en MongoDB (SOLO lectura): ventas diarias, " +
          "pronósticos, forecast, stock de CEDIS y farmacias, órdenes de compra y cargas. " +
          "Usa `agruparPor` + `sumar` para totales (ej: unidades por marca).",
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
            .max(80_000)
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
      await opciones?.onFinish?.({
        texto: text,
        model,
        entrada: totalUsage?.inputTokens ?? 0,
        salida: totalUsage?.outputTokens ?? 0,
        tools: resumirHerramientas(steps ?? []),
      });
    },
  });
}
