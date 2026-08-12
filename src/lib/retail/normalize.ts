// Normalización de encabezados, fechas, números y códigos del Excel
// semanal (§7). Cada función blinda una de las trampas del §7.1.

// Trampa 3: encabezados con espacios sobrantes ("Num Proveedor ").
// Todo lookup de columnas se hace contra esta clave normalizada.
export function normHeader(h: unknown): string {
  return String(h ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .normalize("NFC");
}

// Un cero y un dato ausente no son lo mismo (§7.5): "", null, "ND", "-"
// significan "no reportado" y se convierten a null, nunca a 0.
const AUSENTES = new Set(["", "-", "—", "ND", "N/D", "NA", "N/A", "S/D"]);

export function toNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  if (AUSENTES.has(s.toUpperCase())) return null;
  const n = Number(s.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

// Trampa 5: códigos numéricos que son strings. En CEDIS el Artículo llega
// como float (70006147.0) → truncar; nunca guardar SKU como número.
export function toCode(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") {
    return Number.isFinite(v) ? String(Math.trunc(v)) : "";
  }
  const s = String(v).trim();
  if (/^\d+\.0+$/.test(s)) return s.split(".")[0];
  return s;
}

// "Ubic." llega como entero (141) pero el código real es "0141".
export function toCodigoTienda(v: unknown): string {
  const code = toCode(v);
  if (!code) return "";
  return code.padStart(4, "0");
}

export function toText(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

function utcDate(yyyy: number, mm: number, dd: number): Date | null {
  const d = new Date(Date.UTC(yyyy, mm - 1, dd));
  // Rechaza fechas imposibles (32/13/2026 haría rollover silencioso)
  if (
    d.getUTCFullYear() !== yyyy ||
    d.getUTCMonth() !== mm - 1 ||
    d.getUTCDate() !== dd
  ) {
    return null;
  }
  return d;
}

// Trampa 2: encabezados de fecha en dos formatos. Date real de Excel
// (CEDIS) o string "dd.mm.yyyy" (VENTAS/PRONOSTICOS/FC_Mean).
// ⚠️ "dd.mm.yyyy" se parsea manualmente: new Date("13.05.2026") da
// Invalid Date en V8 justo cuando el día pasa de 12.
export function parseHeaderDate(h: unknown): Date | null {
  if (h instanceof Date) {
    if (Number.isNaN(h.getTime())) return null;
    return new Date(Date.UTC(h.getUTCFullYear(), h.getUTCMonth(), h.getUTCDate()));
  }
  if (typeof h !== "string") return null;
  const s = h.trim();
  const ddmmyyyy = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(s);
  if (ddmmyyyy) {
    return utcDate(Number(ddmmyyyy[3]), Number(ddmmyyyy[2]), Number(ddmmyyyy[1]));
  }
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) {
    return utcDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  }
  return null;
}

// Celdas de fecha dentro de la tabla (Fill Rate). Acepta Date, string en
// ambos formatos y, defensivamente, serial de Excel.
export function parseCellDate(v: unknown): Date | null {
  if (v instanceof Date || typeof v === "string") return parseHeaderDate(v);
  if (typeof v === "number" && Number.isFinite(v) && v > 20000 && v < 80000) {
    // serial de Excel (días desde 1900-01-00), por si cellDates no aplicó
    const ms = Math.round((v - 25569) * 86400 * 1000);
    const d = new Date(ms);
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  }
  return null;
}

// Fecha de corte derivada del nombre del archivo (§7.4). El de muestra usa
// "12.05.2026"; también se aceptan "_" y "-" como separador. Siempre se
// muestra en la UI y se permite corregir antes de procesar.
export function derivarFechaCorte(filename: string): Date | null {
  const m = /(\d{2})[._-](\d{2})[._-](\d{4})/.exec(filename);
  if (!m) return null;
  return utcDate(Number(m[3]), Number(m[2]), Number(m[1]));
}

export function fechaISO(d: Date): string {
  return d.toISOString().slice(0, 10);
}
