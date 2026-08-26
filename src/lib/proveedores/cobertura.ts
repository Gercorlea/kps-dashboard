import Decimal from "decimal.js";

/**
 * Cobertura de una orden de compra: cuanto se pidio, cuanto se ha facturado y
 * cuanto falta.
 *
 * Es el mismo calculo que hace el Portal de Proveedores. Esta duplicado porque
 * son dos proyectos separados sin paquete comun; las reglas se mantienen
 * identicas a proposito, porque si los dos lados discrepan sobre "cuanto falta"
 * el proveedor y KPS discuten sobre numeros distintos.
 *
 * TRES REGLAS QUE NO SON NEGOCIABLES
 *
 *   1. Solo cuenta lo APROBADO. Una factura en revision o rechazada no consume
 *      la orden. Si contara antes de aprobarse, rechazarla dejaria la cuenta
 *      descuadrada.
 *   2. Se compara CANTIDAD por linea, no importe. Es lo unico que permite decir
 *      "faltan 600 piezas" en vez de "faltan 25,200 pesos".
 *   3. Un concepto que no case con ninguna linea NO se ignora: se devuelve
 *      aparte. Descartarlo en silencio haria que una factura con articulos que
 *      la orden no pidio pareciera correcta.
 *
 * Decimal y no `number`: sumar 0.1 + 0.2 en coma flotante da
 * 0.30000000000000004, y eso convierte "cubierta" en "faltan 0.0000000001".
 */

export interface LineaOrden {
  lineNum: number;
  itemCode?: string | null;
  description: string;
  quantity: Decimal;
}

export interface LineaFacturada {
  itemCode?: string | null;
  description: string;
  quantity: Decimal;
}

export interface CoberturaLinea {
  lineNum: number;
  itemCode: string | null;
  description: string;
  ordenado: string;
  /** Cubierto por facturas ya aprobadas, sin contar esta. */
  facturadoAntes: string;
  /** Lo que aporta la factura que se esta revisando. */
  enEsta: string;
  /** Lo que seguiria faltando si esta se aprueba. Nunca negativo. */
  restante: string;
  /** Cuanto se pasa de lo pedido, si se pasa. Nunca negativo. */
  excedente: string;
}

export type EstadoCobertura = "SIN_FACTURAR" | "PARCIAL" | "COMPLETA" | "EXCEDE";

export interface Cobertura {
  lineas: CoberturaLinea[];
  estado: EstadoCobertura;
  /** Conceptos del CFDI que no corresponden a ninguna linea de la orden. */
  sinCorrespondencia: { itemCode: string | null; description: string; quantity: string }[];
  /** True si, aprobando esta factura, la orden queda cubierta del todo. */
  quedaCompleta: boolean;
  lineasPendientes: number;
}

const CERO = new Decimal(0);

/** Sin acentos, sin espacios de sobra y en minusculas: B1 y el CFDI casi nunca escriben igual. */
function clave(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Empareja por `NoIdentificacion` contra `ItemCode` primero, y solo si falta cae
 * a la descripcion. Nunca por posicion: una factura con las lineas en otro orden
 * cuadraria mal sin avisar.
 */
function agrupar(orden: LineaOrden[], facturadas: LineaFacturada[]) {
  const porCodigo = new Map<string, LineaOrden>();
  const porDescripcion = new Map<string, LineaOrden>();
  for (const l of orden) {
    if (l.itemCode) porCodigo.set(clave(l.itemCode), l);
    const d = clave(l.description);
    if (!porDescripcion.has(d)) porDescripcion.set(d, l);
  }

  const porLinea = new Map<number, Decimal>();
  const sueltas: LineaFacturada[] = [];

  for (const f of facturadas) {
    const destino =
      (f.itemCode ? porCodigo.get(clave(f.itemCode)) : undefined) ??
      porDescripcion.get(clave(f.description));
    if (!destino) {
      sueltas.push(f);
      continue;
    }
    porLinea.set(destino.lineNum, (porLinea.get(destino.lineNum) ?? CERO).plus(f.quantity));
  }

  return { porLinea, sueltas };
}

export function calcularCobertura(entrada: {
  orden: LineaOrden[];
  aprobadas: LineaFacturada[];
  enCurso: LineaFacturada[];
}): Cobertura {
  const previas = agrupar(entrada.orden, entrada.aprobadas);
  const actual = agrupar(entrada.orden, entrada.enCurso);

  const lineas: CoberturaLinea[] = entrada.orden.map((l) => {
    const facturadoAntes = previas.porLinea.get(l.lineNum) ?? CERO;
    const enEsta = actual.porLinea.get(l.lineNum) ?? CERO;
    const diferencia = l.quantity.minus(facturadoAntes.plus(enEsta));
    return {
      lineNum: l.lineNum,
      itemCode: l.itemCode ?? null,
      description: l.description,
      ordenado: l.quantity.toString(),
      facturadoAntes: facturadoAntes.toString(),
      enEsta: enEsta.toString(),
      // Acotados a cero: "faltan -50" no lo lee bien nadie, y el exceso tiene su
      // propio campo.
      restante: (diferencia.greaterThan(0) ? diferencia : CERO).toString(),
      excedente: (diferencia.lessThan(0) ? diferencia.negated() : CERO).toString(),
    };
  });

  const excede = lineas.some((l) => new Decimal(l.excedente).greaterThan(0));
  const pendientes = lineas.filter((l) => new Decimal(l.restante).greaterThan(0));
  const nadaFacturado = lineas.every(
    (l) => new Decimal(l.facturadoAntes).isZero() && new Decimal(l.enEsta).isZero()
  );

  return {
    lineas,
    estado: excede
      ? "EXCEDE"
      : nadaFacturado
        ? "SIN_FACTURAR"
        : pendientes.length > 0
          ? "PARCIAL"
          : "COMPLETA",
    sinCorrespondencia: actual.sueltas.map((s) => ({
      itemCode: s.itemCode ?? null,
      description: s.description,
      quantity: s.quantity.toString(),
    })),
    quedaCompleta: !excede && pendientes.length === 0,
    lineasPendientes: pendientes.length,
  };
}
