const DIA_MS = 86_400_000;

/**
 * Obtiene los días pactados sin inventar un plazo.
 *
 * El portal admite un `creditDays` numérico y conserva `paymentTerms` para los
 * proveedores creados antes de ese campo. La variable de entorno sirve como
 * política general únicamente cuando KPS la configura de forma explícita.
 */
export function diasCreditoDe(proveedor: {
  creditDays?: unknown;
  paymentTerms?: unknown;
} | null | undefined): number | null {
  const directo = Number(proveedor?.creditDays);
  if (Number.isInteger(directo) && directo >= 0 && directo <= 365) return directo;

  const texto = typeof proveedor?.paymentTerms === "string" ? proveedor.paymentTerms : "";
  const encontrado = texto.match(/\b(\d{1,3})\b/);
  const desdeTexto = encontrado ? Number(encontrado[1]) : Number.NaN;
  if (Number.isInteger(desdeTexto) && desdeTexto >= 0 && desdeTexto <= 365) return desdeTexto;

  const configurado = Number(process.env.KPS_CREDIT_DAYS_DEFAULT);
  return Number.isInteger(configurado) && configurado >= 0 && configurado <= 365
    ? configurado
    : null;
}

/** Suma días naturales conservando la hora exacta de la liberación. */
export function vencimientoCredito(inicio: Date, dias: number): Date {
  return new Date(inicio.getTime() + dias * DIA_MS);
}

export interface EstadoCredito {
  inicio: string | null;
  vencimiento: string | null;
  dias: number | null;
  diasRestantes: number | null;
  vencida: boolean;
}

/**
 * Resumen listo para presentar. Un resultado negativo expresa días vencidos;
 * cero significa que vence hoy.
 */
export function estadoCredito(datos: {
  inicio?: Date | string | null;
  vencimiento?: Date | string | null;
  dias?: number | null;
  ahora?: Date;
}): EstadoCredito {
  const inicio = datos.inicio ? new Date(datos.inicio) : null;
  const vencimiento = datos.vencimiento ? new Date(datos.vencimiento) : null;
  const ahora = datos.ahora ?? new Date();
  const validos =
    inicio && !Number.isNaN(inicio.getTime()) && vencimiento && !Number.isNaN(vencimiento.getTime());
  const diasRestantes = validos
    ? Math.ceil((vencimiento.getTime() - ahora.getTime()) / DIA_MS)
    : null;

  return {
    inicio: inicio && !Number.isNaN(inicio.getTime()) ? inicio.toISOString() : null,
    vencimiento:
      vencimiento && !Number.isNaN(vencimiento.getTime()) ? vencimiento.toISOString() : null,
    dias: datos.dias ?? null,
    diasRestantes,
    vencida: diasRestantes !== null && diasRestantes < 0,
  };
}
