// Formato del analizador. Reusa los formateadores es-MX de la app (§4.3) y
// sólo agrega lo que allá no existe: notación compacta para ejes y etiquetas
// de gráfica, y el render de una celda cruda de Excel.
//
// Las fechas se muestran en ISO (YYYY-MM-DD) igual que en SheetTable, para que
// todo el módulo retail las lea igual y ordenen como texto.

import { fmtNum, fmtPct } from "@/components/lib/fmt";
import { valorFecha } from "./inferir-tipos";
import type { CeldaCruda, MetaColumna } from "./tipos";

const LOCALE = "es-MX";

const nfDecimal = new Intl.NumberFormat(LOCALE, {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const nfCompacto = new Intl.NumberFormat(LOCALE, {
  notation: "compact",
  maximumFractionDigits: 1,
});

function dosDigitos(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Conteos y totales de filas: 15234 → "15,234". */
export function formatearEntero(n: number): string {
  return fmtNum(n);
}

/**
 * Valores de métrica en la tabla cruda y en tooltips. Los enteros no arrastran
 * ".00" y los decimales se muestran completos: es la vista de datos EN CRUDO,
 * así que la fidelidad manda sobre la brevedad.
 */
export function formatearNumero(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return Number.isInteger(n) ? fmtNum(n) : nfDecimal.format(n);
}

/** Ejes y etiquetas de barra, donde el ancho manda: 1234567 → "1.2 M". */
export function formatearCompacto(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return Math.abs(n) >= 10_000 ? nfCompacto.format(n) : formatearNumero(n);
}

/**
 * Importes: el mismo número con "$" delante.
 *
 * Se antepone el símbolo en vez de usar `style: "currency"` de Intl para que un
 * importe se lea EXACTAMENTE igual que el resto de los números de la app —los
 * enteros sin ".00", los decimales con dos— y sólo se distinga por el signo. Va
 * pegado al número, como se escribe en México: "$1,234.50".
 *
 * El negativo lleva el signo delante del símbolo ("-$120"), que es como lo
 * escribe es-MX y evita el "$-120" que saldría de concatenar sin más.
 */
function conSimbolo(texto: string): string {
  return texto.startsWith("-") ? `-$${texto.slice(1)}` : `$${texto}`;
}

/** Importe con la fidelidad de `formatearNumero`: tablas y tooltips. */
export function formatearMoneda(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return conSimbolo(formatearNumero(n));
}

/** Importe compacto para ejes y etiquetas de barra: 1234567 → "$1.2 M". */
export function formatearMonedaCompacta(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return conSimbolo(formatearCompacto(n));
}

/**
 * Marca de eje. Igual que `formatearCompacto` pero abrevia desde el millar y no
 * desde la decena de millar: en un eje las marcas se leen COMO COLUMNA, y
 * "6,000 · 12 k · 18 k" salta a la vista como un error de formato. El umbral
 * más alto de `formatearCompacto` sigue siendo el correcto para una etiqueta
 * suelta al final de una barra, donde no hay con qué comparar.
 */
export function formatearEje(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return Math.abs(n) >= 1_000 ? nfCompacto.format(n) : formatearNumero(n);
}

/** La misma marca de eje con "$" delante. */
export function formatearEjeMoneda(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return conSimbolo(formatearEje(n));
}

// Mes en UTC y no en local: se formatea una fecha sintética armada con
// Date.UTC, igual que en fmt.ts, para que enero no se muestre como diciembre.
const dfMesCorto = new Intl.DateTimeFormat(LOCALE, { month: "short", timeZone: "UTC" });

/**
 * Número de mes (1-12) → "Ene". Para el eje de la comparativa anual, donde
 * caben doce etiquetas y el nombre completo no.
 */
export function formatearMesCorto(mes: number): string {
  // es-MX devuelve "ene." con punto; sobra en un eje.
  const texto = dfMesCorto.format(new Date(Date.UTC(2000, mes - 1, 1))).replace(".", "");
  return texto.charAt(0).toUpperCase() + texto.slice(1);
}

/** Fecha en ISO local, sin corrimiento de zona horaria. */
export function formatearFecha(d: Date): string {
  return `${d.getFullYear()}-${dosDigitos(d.getMonth() + 1)}-${dosDigitos(d.getDate())}`;
}

/** Fracción (1 = 100%) → porcentaje. */
export function formatearPorcentaje(fraccion: number): string {
  return Number.isFinite(fraccion) ? fmtPct(fraccion) : "—";
}

/**
 * Variación con signo explícito: un "+5%" se distingue de un "5%" a secas.
 *
 * Vive aquí y no en la gráfica porque el KPI de la ficha y la cabecera de la
 * comparativa anual muestran LA MISMA cifra: con dos formateadores, uno de los
 * dos acabaría redondeando distinto.
 */
export function formatearPorcentajeConSigno(fraccion: number): string {
  const texto = formatearPorcentaje(fraccion);
  return fraccion > 0 ? `+${texto}` : texto;
}

/**
 * Valor de celda cruda → texto para la tabla.
 *
 * `esCodigo` apaga los separadores de miles: un "Item Nbr" 101252325 es un
 * identificador, y mostrarlo como "101,252,325" lo hace ilegible y sugiere que
 * es una cantidad.
 */
export function formatearCelda(v: unknown, esCodigo = false): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? "" : formatearFecha(v);
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return "—";
    return esCodigo ? String(v) : formatearNumero(v);
  }
  if (typeof v === "boolean") return v ? "Sí" : "No";
  return String(v);
}

/**
 * Las claves de bucket temporal (ver agregar.ts) ya vienen en ISO
 * ("2024", "2024-03", "2024-03-15"), que es justo como se muestran.
 */
export function formatearClaveTemporal(clave: string): string {
  return clave;
}

/**
 * Celda ya normalizada según el tipo que se infirió para su columna.
 *
 * A diferencia de formatearCelda, que devuelve el texto tal cual viene del
 * archivo, aquí una fecha se muestra siempre en ISO aunque el Excel la traiga
 * como "2024/07/06", y un número escrito como "$ 1,234.00" se muestra con el
 * formato de la app. La tabla y las gráficas quedan diciendo lo mismo.
 */
export function formatearCeldaNormalizada(v: CeldaCruda, col: MetaColumna): string {
  if (v === null || v === undefined || (typeof v === "string" && v.trim() === "")) return "";

  if (col.tipo === "fecha") {
    const d = valorFecha(v, col);
    if (d) return formatearFecha(d);
  }

  // Los códigos se muestran tal cual: el UPC conserva su cero a la izquierda y
  // un "Item Nbr" no lleva separadores de miles.
  if (col.esIdentificador) return formatearCelda(v, true);

  // El "$" sólo cuando la celda acabó siendo un número: un importe que llegó
  // como texto ilegible se muestra tal cual, sin fingir que es dinero.
  const texto = formatearCelda(v);
  return col.esMoneda && typeof v === "number" ? conSimbolo(texto) : texto;
}
