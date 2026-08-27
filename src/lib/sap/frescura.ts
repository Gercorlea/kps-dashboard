// Frescura de lotes: días calculados en el servidor a partir de las fechas
// que trae SAP, para que el modelo nunca reste fechas a mano (se equivoca
// contando días y no tiene reloj fiable).
//
// Se aplica a cualquier fila del Service Layer que traiga ExpirationDate /
// ExpiryDate, ManufacturingDate o AdmissionDate: BatchNumberDetails sobre
// todo, pero también los BatchNumbers de una línea de documento.

const DIA_MS = 86_400_000;
const ZONA = "America/Mexico_City";

/** Hoy a medianoche UTC según la fecha civil de México. */
export function hoyUTC(ahora: Date = new Date()): Date {
  const iso = new Intl.DateTimeFormat("en-CA", {
    timeZone: ZONA,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(ahora);
  return new Date(`${iso}T00:00:00.000Z`);
}

function fechaDe(valor: unknown): Date | null {
  if (typeof valor !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(valor)) return null;
  const d = new Date(`${valor.slice(0, 10)}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function dias(desde: Date, hasta: Date): number {
  return Math.round((hasta.getTime() - desde.getTime()) / DIA_MS);
}

export interface Frescura {
  diasParaVencer?: number; // negativo = ya caducó
  diasDesdeFabricacion?: number;
  diasDesdeIngreso?: number;
  vidaUtilDias?: number; // fabricación → caducidad
  vidaUtilRestantePct?: number; // 0–100 (o negativo si caducó)
  estadoFrescura?: "vigente" | "por vencer" | "caducado";
}

/** Días antes de la caducidad a partir de los cuales un lote es "por vencer". */
export const UMBRAL_POR_VENCER_DIAS = 90;

export function calcularFrescura(fila: Record<string, unknown>, hoy: Date = hoyUTC()): Frescura {
  const caduca = fechaDe(fila.ExpirationDate) ?? fechaDe(fila.ExpiryDate);
  const fabricado = fechaDe(fila.ManufacturingDate);
  const ingreso = fechaDe(fila.AdmissionDate) ?? fechaDe(fila.AddmisionDate);
  const f: Frescura = {};
  if (caduca) {
    f.diasParaVencer = dias(hoy, caduca);
    f.estadoFrescura =
      f.diasParaVencer < 0 ? "caducado" : f.diasParaVencer <= UMBRAL_POR_VENCER_DIAS ? "por vencer" : "vigente";
  }
  if (fabricado) f.diasDesdeFabricacion = dias(fabricado, hoy);
  if (ingreso) f.diasDesdeIngreso = dias(ingreso, hoy);
  if (caduca && fabricado) {
    const vida = dias(fabricado, caduca);
    if (vida > 0) {
      f.vidaUtilDias = vida;
      f.vidaUtilRestantePct = Math.round((f.diasParaVencer! / vida) * 1000) / 10;
    }
  }
  return f;
}

/** Añade los campos de frescura a las filas que traigan fechas de lote. */
export function enriquecerFrescura(
  filas: Record<string, unknown>[],
  hoy: Date = hoyUTC()
): Record<string, unknown>[] {
  return filas.map((fila) => {
    const f = calcularFrescura(fila, hoy);
    return Object.keys(f).length ? { ...fila, ...f } : fila;
  });
}
