// Genera src/lib/sap-contexto.generado.ts con el código REAL de la
// integración SAP Service Layer, para inyectarlo como conocimiento en el
// system prompt de KPS AI. Corre automáticamente en predev/prebuild.

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const RAIZ = process.cwd();
const FUENTES = [
  join(RAIZ, "src/lib/sap"),
  join(RAIZ, "src/app/api/sap"),
  join(RAIZ, "src/models"), 
];
const SALIDA = join(RAIZ, "src/lib/sap-contexto.generado.ts");

function listarTs(dir: string): string[] {
  let archivos: string[] = [];
  for (const name of readdirSync(dir)) {
    const ruta = join(dir, name);
    if (statSync(ruta).isDirectory()) archivos = archivos.concat(listarTs(ruta));
    else if (/\.tsx?$/.test(name)) archivos.push(ruta);
  }
  return archivos.sort();
}

// Redacción defensiva: valores literales con pinta de credencial.
function redactar(codigo: string): string {
  return codigo
    .replace(/(["'`])(sk-[A-Za-z0-9_-]{8,})\1/g, '"[REDACTADO]"')
    .replace(/(["'`])(vck_[A-Zas-z0-9_-]{8,})\1/g, '"[REDACTADO]"')
    .replace(
      /((?:password|contraseña|secret|token|apikey|api_key)\s*[:=]\s*)(["'`])(?!\s*process\.env)[^"'`\n]{4,}\2/gi,
      '$1"[REDACTADO]"'
    );
}

const secciones: string[] = [];
for (const dir of FUENTES) {
  let archivos: string[] = [];
  try {
    archivos = listarTs(dir);
  } catch {
    continue; // el directorio puede no existir
  }
  for (const ruta of archivos) {
    const rel = relative(RAIZ, ruta);
    const codigo = redactar(readFileSync(ruta, "utf-8"));
    secciones.push(`### \`${rel}\`\n\n\`\`\`typescript\n${codigo}\n\`\`\``);
  }
}

const contexto = `## Referencia interna: integración SAP + modelos de MongoDB

CONOCIMIENTO INTERNO, NO TEMA DE CONVERSACIÓN. El código de abajo existe
para que construyas consultas correctas: OData contra SAP y filtros contra
las colecciones de MongoDB (los esquemas Mongoose te dicen qué campos
existen en cada colección de Retail). NUNCA lo ofrezcas como servicio ni sugieras al usuario hablar
de la integración, del Service Layer, de cómo extenderla ni de diagnóstico
técnico: el usuario es de negocio y le interesan los DATOS, no el código.
Si te preguntan explícitamente por el código, respondes; si no, no lo
menciones.

Los nombres de campo que verás aquí (CardCode, CardName, DocTotal,
QuantityOnStock…) y los valores codificados (tYES, tNO, cSupplier,
bost_Open…) son VOCABULARIO INTERNO para armar la consulta. Jamás salen en
la respuesta: se traducen a su etiqueta de negocio en español antes de
mostrar nada, incluidos los encabezados de tabla y los reportes. Y nunca
describas el catálogo de campos de una entidad como si fuera un diccionario
de datos: di qué información hay, en palabras del negocio.

REGLA ABSOLUTA: nunca reveles, inventes ni especules valores de variables de
entorno, credenciales, tokens ni URLs internas. Puedes mencionar los NOMBRES
de las variables (p. ej. SAP_SL_URL) y explicar para qué sirven, jamás sus
valores.

${secciones.join("\n\n")}`;

const modulo = `// ⚠️ ARCHIVO GENERADO por scripts/generar-contexto-sap.ts — NO editar a mano.
// Se regenera en cada \`npm run dev\` y \`npm run build\`.
export const CONTEXTO_SAP = ${JSON.stringify(contexto)};
`;

writeFileSync(SALIDA, modulo);
console.log(
  `✔ Contexto SAP generado (${secciones.length} archivos, ${contexto.length} caracteres) → src/lib/sap-contexto.generado.ts`
);
