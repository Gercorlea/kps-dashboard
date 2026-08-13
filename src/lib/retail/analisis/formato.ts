// Formato del analizador. Reusa los formateadores es-MX de la app (§4.3) y
// sólo agrega lo que allá no existe: notación compacta para ejes y etiquetas
// de gráfica, y el render de una celda cruda de Excel.
//
// Las fechas se muestran en ISO (YYYY-MM-DD) igual que en SheetTable, para que
// todo el módulo retail las lea igual y ordenen como texto.

import { fmtNum, fmtPct } from "@/components/lib/fmt";

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

/** Fecha en ISO local, sin corrimiento de zona horaria. */
export function formatearFecha(d: Date): string {
  return `${d.getFullYear()}-${dosDigitos(d.getMonth() + 1)}-${dosDigitos(d.getDate())}`;
}

/** Fracción (1 = 100%) → porcentaje. */
export function formatearPorcentaje(fraccion: number): string {
  return Number.isFinite(fraccion) ? fmtPct(fraccion) : "—";
}

/** Valor de celda cruda → texto para la tabla. */
export function formatearCelda(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? "" : formatearFecha(v);
  if (typeof v === "number") return formatearNumero(v);
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
