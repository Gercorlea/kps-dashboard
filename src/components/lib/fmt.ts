// Formato numérico es-MX consistente en toda la app (§4.3: números en
// mono con tabular-nums; el CSS lo aplica, aquí solo el texto).

const nf = new Intl.NumberFormat("es-MX", { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat("es-MX", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

export function fmtNum(v: number | null | undefined): string {
  return v === null || v === undefined ? "—" : nf.format(v);
}

export function fmtDec(v: number | null | undefined): string {
  return v === null || v === undefined ? "—" : nf1.format(v);
}

// Fracción (1 = 100%) → porcentaje. null → "—", nunca ∞ (§8.1).
export function fmtPct(v: number | null | undefined, conSigno = false): string {
  if (v === null || v === undefined) return "—";
  const pct = v * 100;
  const signo = conSigno && pct > 0 ? "+" : "";
  return `${signo}${nf1.format(pct)}%`;
}

export function fmtFecha(iso: string | null | undefined): string {
  if (!iso) return "—";
  return iso.slice(0, 10);
}

// Mes en clave "2026-07" → texto. Se formatea en UTC porque la clave se arma
// en UTC (stats.ts): con la zona local, julio se mostraría como junio.
const dfMes = new Intl.DateTimeFormat("es-MX", {
  month: "short",
  year: "2-digit",
  timeZone: "UTC",
});
const dfMesLargo = new Intl.DateTimeFormat("es-MX", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

function mesUTC(periodo: string): Date {
  const [a, m] = periodo.split("-").map(Number);
  return new Date(Date.UTC(a, m - 1, 1));
}

/** "2026-07" → "jul 26". */
export function fmtMes(periodo: string | null | undefined): string {
  return periodo ? dfMes.format(mesUTC(periodo)) : "—";
}

/** "2026-07" → "julio de 2026". */
export function fmtMesLargo(periodo: string | null | undefined): string {
  return periodo ? dfMesLargo.format(mesUTC(periodo)) : "—";
}

export function fmtFechaHora(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${iso.slice(0, 10)} ${String(d.getHours()).padStart(2, "0")}:${String(
    d.getMinutes()
  ).padStart(2, "0")}`;
}

export function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${nf1.format(n / (1024 * 1024))} MB`;
  if (n >= 1024) return `${nf.format(Math.round(n / 1024))} KB`;
  return `${nf.format(n)} B`;
}
