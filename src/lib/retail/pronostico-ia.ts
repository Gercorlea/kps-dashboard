// Pronóstico de ventas para KPS AI: serie mensual del histórico + proyección.
//
// El modelo NO calcula: pide el pronóstico ya hecho, igual que pide los
// totales. Aquí se agrega el histórico por mes en Mongo y se proyecta con un
// método simple y explicable —tendencia lineal, con estacionalidad cuando
// hay dos años completos—, que es lo que una persona de ventas puede seguir
// y discutir. No es un modelo estadístico sofisticado a propósito: un
// pronóstico que nadie entiende no se usa.
//
// Lo que sí se cuida, porque cambia el resultado:
//   - Un mes sin datos es un HUECO (no hubo reporte), no cero ventas: no
//     entra al ajuste y se avisa.
//   - Un mes con datos sólo de parte del mes (empieza tarde, acaba pronto,
//     o —en una serie que suma retailers— le falta alguno) es PARCIAL: no
//     entra al ajuste. El último, además, se proyecta como primer mes del
//     horizonte.
//   - Con estacionalidad, la tendencia se estima con diferencias
//     interanuales (mismo mes del año anterior): una recta de mínimos
//     cuadrados sobre la serie cruda absorbe el pico de diciembre como si
//     fuera crecimiento y desplaza todo el pronóstico (~20% medido).
//   - Nada se proyecta por debajo de cero.
//   - Cada pronóstico lleva su PRUEBA RETROSPECTIVA: se ocultan los últimos
//     meses reales, se pronostican con el MISMO método y se mide el error.
//     Es la única forma honesta de decir "qué tan bien funciona esto".
//   - Un último mes que se sale de la mediana de los anteriores se señala
//     como atípico: la recta lo convierte en tendencia y el usuario tiene
//     que saberlo (y poder excluirlo con `excluirMeses`).
import { connectDB } from "@/lib/db";
import { asegurarFacturasFrescas } from "@/lib/sap/sincronizar-facturas";
import {
  campoDe,
  campoPermitido,
  camposDe,
  construirFiltro,
  fechaDe,
  metricaSumable,
  modeloDe,
  type ColeccionRetail,
  type ConsultaRetail,
} from "./consultas-ia";

export interface PuntoMes {
  mes: string; // "2026-05"
  valor: number;
  /** El mes no está completo en el histórico (se excluye del ajuste). */
  parcial?: boolean;
  /** Por qué es parcial, en palabras de negocio. */
  motivoParcial?: string;
  /** Primer y último día del mes con datos (histórico). */
  primerDia?: number;
  ultimoDia?: number;
  /** Sólo en el pronóstico: el mes ya pasó respecto a hoy. */
  transcurrido?: boolean;
}

export type MetodoProyeccion = "estacional" | "tendencia" | "promedio";
export type Confianza = "alta" | "media" | "baja";

export interface PruebaRetrospectiva {
  /** Meses reales que se ocultaron y se pronosticaron. */
  meses: number;
  /** Método con el que se hizo la prueba (el mismo del pronóstico, si se pudo). */
  metodo: MetodoProyeccion;
  /** Error absoluto medio en porcentaje del valor real (MAPE sobre |real|); null si ningún mes fue medible. */
  errorMedioPct: number | null;
  motivo?: string;
  detalle: Array<{ mes: string; real: number; proyectado: number; errorPct: number | null }>;
}

export interface Proyeccion {
  metodo: MetodoProyeccion;
  confianza: Confianza;
  /** Hasta qué mes hay datos completos: el pronóstico empieza al siguiente. */
  ultimoMesCompleto: string;
  primerMesCompleto: string;
  /** Meses completos que entraron al ajuste. */
  mesesAjustados: number;
  historico: PuntoMes[];
  pronostico: PuntoMes[];
  /** Media de los meses completos. */
  promedioMensual: number;
  /** Cambio por mes según el ajuste (0 en el método promedio). */
  tendenciaMensual: number;
  /** Valor de la tendencia (sin estacionalidad) en el último mes completo. */
  nivelUltimoMesCompleto: number;
  /** Factor por mes calendario (enero…diciembre), sólo con método estacional. */
  indicesEstacionales?: number[];
  /** Total proyectado del horizonte. */
  totalPronostico: number;
  /** null cuando la serie es demasiado corta para reservar meses de prueba. */
  pruebaRetrospectiva: PruebaRetrospectiva | null;
  /** Último mes completo que se sale de la mediana de los anteriores. */
  mesAtipico?: { mes: string; desviacionPct: number };
  /** Meses entre el último completo y el mes actual (0 = está al día). */
  mesesDesdeUltimoDato?: number;
  notas: string[];
}

/** Meses completos mínimos para ajustar una tendencia; por debajo, promedio. */
const MIN_TENDENCIA = 6;
/** Meses completos mínimos para estimar estacionalidad (dos vueltas al año). */
const MIN_ESTACIONAL = 24;
/** Día a partir del cual un mes se da por completo por su final. */
const DIA_MES_COMPLETO = 28;
/** Día hasta el cual un mes se da por completo por su inicio. */
const DIA_MES_INICIO = 3;
/** Meses que se reservan para la prueba retrospectiva. */
const MESES_PRUEBA = 3;
/** Error de la prueba a partir del cual la confianza baja un escalón / dos. */
const ERROR_MEDIO_PCT = 15;
const ERROR_ALTO_PCT = 30;
/** Desviación del último mes frente a la mediana previa para llamarlo atípico. */
const ATIPICO_PCT = 50;
const HORIZONTE_MAX = 12;
const HORIZONTE_DEFECTO = 3;
const MAX_GRUPOS = 10;
const MES_RE = /^\d{4}-\d{2}$/;

export function indiceMes(mes: string): number {
  const [a, m] = mes.split("-").map(Number);
  return a * 12 + (m - 1);
}

export function mesDeIndice(i: number): string {
  const a = Math.floor(i / 12);
  const m = (i % 12) + 1;
  return `${a}-${String(m).padStart(2, "0")}`;
}

function redondear(v: number): number {
  return Math.round(v * 100) / 100;
}

/** Mes actual (AAAA-MM) según la fecha civil de México. */
export function mesActualMX(ahora: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Mexico_City",
    year: "numeric",
    month: "2-digit",
  })
    .format(ahora)
    .slice(0, 7);
}

interface Ajuste {
  metodo: MetodoProyeccion;
  promedio: number;
  pendiente: number;
  indices: number[] | null;
  /** Tendencia sin estacionalidad en un índice de mes absoluto. */
  nivel: (indiceAbsoluto: number) => number;
  /** Valor proyectado (tendencia × estacionalidad, nunca negativo). */
  en: (indiceAbsoluto: number) => number;
  notas: string[];
}

/**
 * Ajusta el método a una serie de meses COMPLETOS ya ordenados. Es el núcleo
 * que se reutiliza para el pronóstico y para la prueba retrospectiva.
 *
 * `objetivo` es para la prueba: al entrenar con menos meses, los umbrales
 * elegirían un método más pobre que el del pronóstico final (24 meses dan
 * estacionalidad; 21 ya no) y la prueba mediría OTRO método. Con objetivo se
 * fuerza el mismo, aceptando una sola vuelta por mes calendario para la
 * estacionalidad. Si ni así se puede, cae al método que sí alcance.
 */
function ajustar(completos: PuntoMes[], objetivo?: MetodoProyeccion): Ajuste {
  const notas: string[] = [];
  const n = completos.length;
  const primero = indiceMes(completos[0].mes);
  // Meses que ABARCA la serie (con huecos): dos años con un mes ausente
  // siguen siendo dos vueltas del calendario.
  const abarca = indiceMes(completos[n - 1].mes) - primero + 1;
  const xs = completos.map((p) => indiceMes(p.mes) - primero);
  const ys = completos.map((p) => p.valor);
  const promedio = ys.reduce((a, b) => a + b, 0) / n;
  const mx = xs.reduce((s, x) => s + x, 0) / n;

  // Recta de mínimos cuadrados: valor = a + b·x.
  const sxx = xs.reduce((s, x) => s + (x - mx) ** 2, 0);
  const bOLS = sxx === 0 ? 0 : xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - promedio), 0) / sxx;

  let a = promedio;
  let b = 0;
  let metodo: MetodoProyeccion = "promedio";
  if (n >= MIN_TENDENCIA) {
    b = bOLS;
    a = promedio - b * mx;
    metodo = "tendencia";
  }

  // Estacionalidad multiplicativa por mes calendario. La tendencia se estima
  // con diferencias interanuales (mismo mes del año anterior): sobre una serie
  // con estacionalidad, la recta cruda toma el pico de fin de año como
  // crecimiento y desplaza todo el pronóstico. Con pares interanuales una
  // serie periódica da pendiente 0, que es lo correcto.
  let indices: number[] | null = null;
  const forzarEstacional = objetivo === "estacional" && metodo === "tendencia";
  const intentarEstacional =
    objetivo !== "tendencia" && objetivo !== "promedio" && (abarca >= MIN_ESTACIONAL || forzarEstacional);
  if (intentarEstacional) {
    const porIndice = new Map(completos.map((p) => [indiceMes(p.mes), p.valor]));
    const diferencias: number[] = [];
    for (const [i, v] of porIndice) {
      const previo = porIndice.get(i - 12);
      if (previo !== undefined) diferencias.push(v - previo);
    }
    const bInteranual = diferencias.length
      ? diferencias.reduce((s, d) => s + d, 0) / diferencias.length / 12
      : bOLS;
    const calendario = completos.map((p) => indiceMes(p.mes) % 12);

    // Razón real/tendencia promediada por mes calendario y normalizada a
    // media 1. Un mes calendario sin ninguna observación (hueco en los dos
    // años) no tira el método entero: su índice se interpola de los vecinos y
    // se avisa. Con más de dos meses así ya no es estacionalidad, es adivinar.
    const MAX_INTERPOLADOS = 2;
    let interpolados: number[] = [];
    let conUnAnio: number[] = [];
    const calcularIndices = (nivel0: number, pendiente: number): number[] | null => {
      const sumas = new Array<number>(12).fill(0);
      const cuentas = new Array<number>(12).fill(0);
      completos.forEach((p, i) => {
        const t = nivel0 + pendiente * xs[i];
        if (t <= 0) return;
        sumas[calendario[i]] += p.valor / t;
        cuentas[calendario[i]] += 1;
      });
      const vacios = cuentas.map((c, m) => (c === 0 ? m : -1)).filter((m) => m >= 0);
      if (vacios.length > MAX_INTERPOLADOS) return null;
      const brutos = sumas.map((s, c) => (cuentas[c] ? s / cuentas[c] : NaN));
      for (const m of vacios) {
        let izq = (m + 11) % 12;
        let der = (m + 1) % 12;
        while (Number.isNaN(brutos[izq]) && izq !== m) izq = (izq + 11) % 12;
        while (Number.isNaN(brutos[der]) && der !== m) der = (der + 1) % 12;
        brutos[m] = Number.isNaN(brutos[izq]) || Number.isNaN(brutos[der]) ? 1 : (brutos[izq] + brutos[der]) / 2;
      }
      interpolados = vacios;
      conUnAnio = cuentas.map((c, m) => (c === 1 && !forzarEstacional ? m : -1)).filter((m) => m >= 0);
      const media = brutos.reduce((s, v) => s + v, 0) / 12;
      return media > 0 ? brutos.map((v) => v / media) : null;
    };

    // El nivel NO puede ser la media cruda: si la muestra no cubre vueltas
    // enteras (21 meses en la prueba retrospectiva), la media queda sesgada
    // por qué meses del ciclo entraron. Se estima sobre la serie
    // desestacionalizada y se itera nivel → índices → nivel → pendiente
    // (las diferencias interanuales también se desestacionalizan), que
    // converge en dos pasadas (exacto para una serie periódica).
    let pendiente = bInteranual;
    let nivel0 = promedio - pendiente * mx;
    let candidatos = calcularIndices(nivel0, pendiente);
    if (candidatos) {
      const porIndicePunto = new Map(completos.map((p, i) => [indiceMes(p.mes), i]));
      for (let k = 0; k < 3 && candidatos; k++) {
        const den = calendario.reduce((s, c) => s + candidatos![c], 0);
        const num = completos.reduce(
          (s, p, i) => s + p.valor - pendiente * xs[i] * candidatos![calendario[i]],
          0
        );
        if (den > 0) nivel0 = num / den;
        if (diferencias.length) {
          let suma = 0;
          let cuenta = 0;
          for (const [i, idx] of porIndicePunto) {
            const previo = porIndicePunto.get(i - 12);
            if (previo === undefined) continue;
            const factor = candidatos![calendario[idx]];
            if (factor > 0) {
              suma += (completos[idx].valor - completos[previo].valor) / factor;
              cuenta += 1;
            }
          }
          if (cuenta) pendiente = suma / cuenta / 12;
        }
        candidatos = calcularIndices(nivel0, pendiente) ?? candidatos;
      }
      indices = candidatos;
      a = nivel0;
      b = pendiente;
      metodo = "estacional";
      const nombre = (m: number) => String(m + 1).padStart(2, "0");
      if (interpolados.length) {
        notas.push(
          `Sin datos de ${interpolados.map(nombre).join(" y ")} en ningún año: su factor ` +
            "estacional se estimó a partir de los meses vecinos."
        );
      }
      if (conUnAnio.length) {
        notas.push(`El factor estacional de ${conUnAnio.map(nombre).join(", ")} se estimó con un solo año.`);
      }
    } else if (abarca >= MIN_ESTACIONAL) {
      notas.push(
        "Hay dos años de histórico pero la estacionalidad no se pudo estimar " +
          "(faltan demasiados meses o la tendencia no es positiva): se usa sólo la tendencia."
      );
    }
  }

  const nivel = (i: number) => a + b * (i - primero);
  return {
    metodo,
    promedio,
    pendiente: b,
    indices,
    nivel,
    en: (i) => Math.max(0, nivel(i) * (indices ? indices[i % 12] : 1)),
    notas,
  };
}

function pruebaRetrospectiva(
  completos: PuntoMes[],
  metodo: MetodoProyeccion
): PruebaRetrospectiva | null {
  // Hace falta que, quitando los meses de prueba, quede al menos una serie
  // con la que ajustar una tendencia; si no, la prueba mediría otro método.
  if (completos.length < MIN_TENDENCIA + MESES_PRUEBA) return null;
  const entrenamiento = completos.slice(0, -MESES_PRUEBA);
  const prueba = completos.slice(-MESES_PRUEBA);
  const ajuste = ajustar(entrenamiento, metodo);

  const detalle = prueba.map((p) => {
    const proyectado = ajuste.en(indiceMes(p.mes));
    // |real| como base: un mes negativo (devoluciones) daría un error
    // negativo que "mejoraría" el promedio. Un real ~0 no es medible.
    const base = Math.abs(p.valor);
    const errorPct = base < 1e-9 ? null : (Math.abs(proyectado - p.valor) / base) * 100;
    return {
      mes: p.mes,
      real: redondear(p.valor),
      proyectado: redondear(proyectado),
      errorPct: errorPct === null ? null : redondear(errorPct),
    };
  });
  const medibles = detalle.filter((d) => d.errorPct !== null) as Array<{ errorPct: number }>;
  if (!medibles.length) {
    return {
      meses: MESES_PRUEBA,
      metodo: ajuste.metodo,
      errorMedioPct: null,
      motivo: "los meses reales reservados para la prueba están en cero: el error no se puede medir en porcentaje",
      detalle,
    };
  }
  return {
    meses: MESES_PRUEBA,
    metodo: ajuste.metodo,
    errorMedioPct: redondear(medibles.reduce((s, d) => s + d.errorPct, 0) / medibles.length),
    detalle,
  };
}

export interface OpcionesProyeccion {
  /** Meses a proyectar tras el último completo (1–12). */
  horizonte?: number;
  /** Proyectar hasta este mes (AAAA-MM) en vez de un número de meses. */
  hastaMes?: string;
  /** Mes actual (AAAA-MM): marca como transcurridos los meses ya pasados. */
  mesActual?: string;
  /** Meses (AAAA-MM) que se sacan del ajuste a petición del usuario. */
  excluirMeses?: string[];
  /** Notas que vienen de fuera (p. ej. de cómo se armó la serie). */
  notas?: string[];
}

/**
 * Proyecta a partir de un histórico mensual. Pura: sin base ni reloj propio
 * (el mes actual entra por opciones), para poder probarla con series
 * sintéticas.
 */
export function proyectarSerie(
  historico: PuntoMes[],
  horizonteOOpciones: number | OpcionesProyeccion = HORIZONTE_DEFECTO
): Proyeccion {
  const opciones: OpcionesProyeccion =
    typeof horizonteOOpciones === "number" ? { horizonte: horizonteOOpciones } : horizonteOOpciones;
  const notas: string[] = [...(opciones.notas ?? [])];
  const excluir = new Set(opciones.excluirMeses ?? []);
  const orden = [...historico]
    .sort((a, b) => indiceMes(a.mes) - indiceMes(b.mes))
    .map((p) =>
      excluir.has(p.mes) ? { ...p, parcial: true, motivoParcial: "excluido a petición del usuario" } : p
    );
  const completos = orden.filter((p) => !p.parcial);
  if (completos.length === 0) {
    throw new Error("No hay ningún mes completo en el histórico para proyectar.");
  }
  const ultimo = indiceMes(completos[completos.length - 1].mes);
  const primero = indiceMes(completos[0].mes);

  for (const p of orden) {
    if (!p.parcial) continue;
    const motivo = p.motivoParcial ? ` (${p.motivoParcial})` : "";
    notas.push(
      indiceMes(p.mes) > ultimo
        ? `El mes ${p.mes} está incompleto en el histórico${motivo}: no entra al ajuste y se proyecta.`
        : `El mes ${p.mes} está incompleto en el histórico${motivo} y no entra al ajuste.`
    );
  }

  // Huecos: meses sin NINGÚN dato entre el primero y el último completo (un
  // mes parcial tiene datos: ya lleva su propia nota).
  const presentes = new Set(orden.map((p) => indiceMes(p.mes)));
  const huecos: string[] = [];
  for (let i = primero; i <= ultimo; i++) if (!presentes.has(i)) huecos.push(mesDeIndice(i));
  if (huecos.length) {
    notas.push(
      `Meses sin datos en el histórico (no cuentan como cero): ${huecos.slice(0, 6).join(", ")}` +
        (huecos.length > 6 ? ` y ${huecos.length - 6} más` : "") +
        "."
    );
  }

  const n = completos.length;
  const ajuste = ajustar(completos);
  notas.push(...ajuste.notas);
  if (ajuste.metodo === "promedio") {
    notas.push(`Serie corta (${n} meses completos): se proyecta el promedio mensual.`);
  } else if (ajuste.metodo === "tendencia" && ultimo - primero + 1 < MIN_ESTACIONAL) {
    notas.push(
      n >= 12
        ? "Sin estacionalidad: hacen falta dos años completos para estimarla."
        : "Menos de un año de histórico: la tendencia puede estar sesgada por el periodo cargado."
    );
  }

  // Mes atípico: el último completo frente a lo que el MISMO método, ajustado
  // sin ese mes, habría previsto para él. Compararlo con la mediana daba
  // falsos positivos en cualquier serie con tendencia sostenida. La recta lo
  // trata como tendencia, y eso hay que decirlo.
  let mesAtipico: Proyeccion["mesAtipico"];
  if (n >= MIN_TENDENCIA) {
    const sinUltimo = ajustar(completos.slice(0, -1), ajuste.metodo);
    const esperado = sinUltimo.en(ultimo);
    const ultimoValor = completos[n - 1].valor;
    if (Math.abs(esperado) > 1e-9) {
      const desviacionPct = ((ultimoValor - esperado) / Math.abs(esperado)) * 100;
      if (Math.abs(desviacionPct) > ATIPICO_PCT) {
        mesAtipico = { mes: completos[n - 1].mes, desviacionPct: redondear(desviacionPct) };
        notas.push(
          `El mes ${mesAtipico.mes} está un ${Math.abs(mesAtipico.desviacionPct)}% ` +
            `${desviacionPct > 0 ? "por encima" : "por debajo"} de lo que llevaban los meses anteriores: ` +
            "el pronóstico lo trata como tendencia. Si fue algo puntual, la proyección está " +
            `${desviacionPct > 0 ? "sobre" : "sub"}estimada; se puede rehacer excluyendo ese mes.`
        );
      }
    }
  }

  // Horizonte: fijo, o hasta un mes concreto.
  let horizonte = Math.min(Math.max(Math.trunc(opciones.horizonte ?? HORIZONTE_DEFECTO), 1), HORIZONTE_MAX);
  if (opciones.hastaMes && MES_RE.test(opciones.hastaMes)) {
    const pedido = indiceMes(opciones.hastaMes) - ultimo;
    if (pedido <= 0) {
      horizonte = 0;
      notas.push(`Ya hay datos reales hasta ${mesDeIndice(ultimo)}: no hay nada que proyectar hasta ${opciones.hastaMes}.`);
    } else if (pedido > HORIZONTE_MAX) {
      horizonte = HORIZONTE_MAX;
      notas.push(`El horizonte se recorta a ${HORIZONTE_MAX} meses (hasta ${mesDeIndice(ultimo + HORIZONTE_MAX)}).`);
    } else {
      horizonte = pedido;
    }
  }

  const mesActual = opciones.mesActual && MES_RE.test(opciones.mesActual) ? indiceMes(opciones.mesActual) : null;
  const pronostico: PuntoMes[] = [];
  for (let k = 1; k <= horizonte; k++) {
    const i = ultimo + k;
    const punto: PuntoMes = { mes: mesDeIndice(i), valor: redondear(ajuste.en(i)) };
    if (mesActual !== null && i < mesActual) punto.transcurrido = true;
    pronostico.push(punto);
  }
  let mesesDesdeUltimoDato: number | undefined;
  if (mesActual !== null) {
    mesesDesdeUltimoDato = Math.max(0, mesActual - ultimo);
    if (mesesDesdeUltimoDato > 1) {
      notas.push(
        `La serie termina ${mesesDesdeUltimoDato} meses antes del mes actual: los meses proyectados ` +
          "anteriores a hoy son estimaciones de meses ya transcurridos sin datos cargados."
      );
    }
  }

  // Confianza: la que da el método, rebajada por lo que diga la prueba.
  const niveles: Confianza[] = ["baja", "media", "alta"];
  let nivel = ajuste.metodo === "estacional" ? 2 : n >= 12 ? 1 : 0;
  const prueba = pruebaRetrospectiva(completos, ajuste.metodo);
  if (prueba && prueba.errorMedioPct !== null) {
    const escalones = prueba.errorMedioPct > ERROR_ALTO_PCT ? 2 : prueba.errorMedioPct > ERROR_MEDIO_PCT ? 1 : 0;
    if (escalones) {
      nivel = Math.max(0, nivel - escalones);
      notas.push(
        `En la prueba retrospectiva (últimos ${prueba.meses} meses reales) el método se equivocó ` +
          `un ${prueba.errorMedioPct}% en promedio: la confianza se rebaja.`
      );
    }
  } else if (prueba) {
    notas.push(`Prueba retrospectiva sin medida: ${prueba.motivo}.`);
  } else {
    notas.push("Serie demasiado corta para una prueba retrospectiva: el error del método no se pudo medir.");
  }

  return {
    metodo: ajuste.metodo,
    confianza: niveles[nivel],
    ultimoMesCompleto: mesDeIndice(ultimo),
    primerMesCompleto: mesDeIndice(primero),
    mesesAjustados: n,
    historico: orden.map((p) => ({ ...p, valor: redondear(p.valor) })),
    pronostico,
    promedioMensual: redondear(ajuste.promedio),
    tendenciaMensual: redondear(ajuste.pendiente),
    nivelUltimoMesCompleto: redondear(ajuste.nivel(ultimo)),
    ...(ajuste.indices ? { indicesEstacionales: ajuste.indices.map((v) => Math.round(v * 1000) / 1000) } : {}),
    totalPronostico: redondear(pronostico.reduce((s, p) => s + p.valor, 0)),
    pruebaRetrospectiva: prueba,
    ...(mesAtipico ? { mesAtipico } : {}),
    ...(mesesDesdeUltimoDato !== undefined ? { mesesDesdeUltimoDato } : {}),
    notas,
  };
}

// ---------------------------------------------------------------------------
// De filas agregadas a series (pura, probada sin Mongo)
// ---------------------------------------------------------------------------

/** Una fila del $group: un grupo × mes. */
export interface FilaAgregada {
  grupo: unknown;
  mes: string;
  valor: number;
  primerDia: number;
  ultimoDia: number;
  primeraFecha?: Date;
  ultimaFecha?: Date;
  /** Cuentas (retailers) con datos ese mes; sólo en series que las combinan. */
  cuentas?: string[];
}

export interface CoberturaCuenta {
  cuenta: string;
  desde: string; // primer mes con datos
  hasta: string; // último mes con datos
  meses: number;
}

export interface SeriePronostico {
  grupo: string | null;
  totalHistorico: number;
  /** Cobertura real en días. */
  primerDiaConDatos: string | null;
  ultimoDiaConDatos: string | null;
  /** Retailers que suma la serie y qué meses cubre cada uno, cuando combina varios. */
  cuentas?: CoberturaCuenta[];
  /** null cuando no hay ningún mes completo; `motivo` lo explica. */
  proyeccion: Proyeccion | null;
  motivo?: string;
}

/** Meses con datos que necesita una cuenta para contar en una serie combinada. */
const MIN_MESES_CUENTA = 3;

/**
 * Marca parcial cada mes que empieza tarde, acaba pronto o —en una serie que
 * suma retailers— al que le falta alguno de los que ya venían reportando.
 * Un retailer sólo se echa en falta a partir de su primer mes con datos (los
 * meses anteriores a que empezara no son incompletos) y si aparece en al
 * menos MIN_MESES_CUENTA meses (una fila suelta no define cobertura).
 */
export function marcarParciales(puntos: PuntoMes[], referencia?: CoberturaCuenta[]): PuntoMes[] {
  const exigidas = (referencia ?? []).filter((c) => c.meses >= MIN_MESES_CUENTA);
  return puntos.map((p) => {
    const q = { ...p };
    const motivos: string[] = [];
    if (q.primerDia !== undefined && q.primerDia > DIA_MES_INICIO) motivos.push(`datos desde el día ${q.primerDia}`);
    if (q.ultimoDia !== undefined && q.ultimoDia < DIA_MES_COMPLETO) motivos.push(`datos hasta el día ${q.ultimoDia}`);
    const cuentasMes = (p as { cuentas?: string[] }).cuentas;
    if (exigidas.length > 1 && cuentasMes) {
      const i = indiceMes(p.mes);
      const faltan = exigidas.filter((c) => indiceMes(c.desde) <= i && !cuentasMes.includes(c.cuenta));
      if (faltan.length) motivos.push(`sin datos de ${faltan.map((c) => c.cuenta).join(", ")}`);
    }
    if (motivos.length) {
      q.parcial = true;
      q.motivoParcial = motivos.join("; ");
    }
    delete (q as { cuentas?: string[] }).cuentas;
    return q;
  });
}

function fechaISO(d: Date | undefined): string | null {
  return d instanceof Date ? d.toISOString().slice(0, 10) : null;
}

export function seriesDesdeFilas(
  filas: FilaAgregada[],
  opciones: OpcionesProyeccion & { maxGrupos?: number } = {}
): { series: SeriePronostico[]; gruposOmitidos: number } {
  interface Grupo {
    puntos: Array<PuntoMes & { cuentas?: string[] }>;
    total: number;
    primera?: Date;
    ultima?: Date;
    /** Por cuenta: meses (índice absoluto) con datos. */
    cuentas: Map<string, number[]>;
  }
  const porGrupo = new Map<string | null, Grupo>();
  for (const f of [...filas].sort((a, b) => indiceMes(a.mes) - indiceMes(b.mes))) {
    const clave = f.grupo === null || f.grupo === undefined ? null : String(f.grupo);
    const g = porGrupo.get(clave) ?? { puntos: [], total: 0, cuentas: new Map<string, number[]>() };
    const cuentasMes = (f.cuentas ?? []).filter((c) => c !== null && c !== undefined).map(String);
    g.puntos.push({
      mes: f.mes,
      valor: f.valor,
      primerDia: f.primerDia,
      ultimoDia: f.ultimoDia,
      ...(f.cuentas ? { cuentas: cuentasMes } : {}),
    });
    g.total += f.valor;
    if (f.primeraFecha && (!g.primera || f.primeraFecha < g.primera)) g.primera = f.primeraFecha;
    if (f.ultimaFecha && (!g.ultima || f.ultimaFecha > g.ultima)) g.ultima = f.ultimaFecha;
    for (const c of cuentasMes) g.cuentas.set(c, [...(g.cuentas.get(c) ?? []), indiceMes(f.mes)]);
    porGrupo.set(clave, g);
  }

  const max = opciones.maxGrupos ?? MAX_GRUPOS;
  const grupos = [...porGrupo.entries()].sort((x, y) => y[1].total - x[1].total);
  const series: SeriePronostico[] = grupos.slice(0, max).map(([grupo, g]) => {
    const referencia: CoberturaCuenta[] | undefined =
      g.cuentas.size > 1
        ? [...g.cuentas.entries()]
            .map(([cuenta, meses]) => ({
              cuenta,
              desde: mesDeIndice(Math.min(...meses)),
              hasta: mesDeIndice(Math.max(...meses)),
              meses: meses.length,
            }))
            .sort((x, y) => x.cuenta.localeCompare(y.cuenta))
        : undefined;
    const puntos = marcarParciales(g.puntos, referencia);
    const notas: string[] = [];
    if (referencia) {
      const porCuenta = puntos.filter((p) => p.motivoParcial?.includes("sin datos de")).length;
      if (porCuenta) {
        notas.push(
          "La serie suma varios retailers con coberturas distintas (" +
            referencia.map((c) => `${c.cuenta} ${c.desde}→${c.hasta}`).join("; ") +
            `): ${porCuenta} mes(es) quedan incompletos por faltarles alguno. ` +
            "Para un pronóstico por retailer, pide una serie por cuenta."
        );
      }
    }
    const base: Omit<SeriePronostico, "proyeccion"> = {
      grupo,
      totalHistorico: redondear(g.total),
      primerDiaConDatos: fechaISO(g.primera),
      ultimoDiaConDatos: fechaISO(g.ultima),
      ...(referencia ? { cuentas: referencia } : {}),
    };
    if (!puntos.some((p) => !p.parcial)) {
      return {
        ...base,
        proyeccion: null,
        motivo:
          `Sólo hay datos de meses incompletos (${puntos.map((p) => p.mes).join(", ")}): ` +
          "hacen falta meses completos para proyectar.",
      };
    }
    try {
      return { ...base, proyeccion: proyectarSerie(puntos, { ...opciones, notas }) };
    } catch (e) {
      return { ...base, proyeccion: null, motivo: e instanceof Error ? e.message : "No se pudo proyectar." };
    }
  });
  return { series, gruposOmitidos: Math.max(0, grupos.length - max) };
}

// ---------------------------------------------------------------------------
// Desde Mongo
// ---------------------------------------------------------------------------

export interface ConsultaPronostico {
  coleccion: ColeccionRetail;
  filtros?: ConsultaRetail["filtros"];
  /** Campo numérico sumable a proyectar (posQty, posSales, quantity, lineTotal). */
  metrica: string;
  /** Meses a proyectar (1–12). */
  horizonte?: number;
  /** Proyectar hasta este mes (AAAA-MM); manda sobre `horizonte`. */
  hastaMes?: string;
  /** Meses (AAAA-MM) que se excluyen del ajuste. */
  excluirMeses?: string[];
  /** Una serie por valor de este campo (account, brand…), las mayores primero. */
  agruparPor?: string;
}

export interface ResultadoPronostico {
  metrica: string;
  etiqueta: string;
  mesActual: string;
  series: SeriePronostico[];
  /** Grupos que quedaron fuera por el tope (las series van de mayor a menor volumen). */
  gruposOmitidos: number;
  aviso?: string;
  camposIgnorados?: string[];
}

export async function pronosticarRetail(consulta: ConsultaPronostico): Promise<ResultadoPronostico> {
  const fecha = fechaDe(consulta.coleccion);
  if (!fecha) throw new Error(`La colección ${consulta.coleccion} no tiene fechas: no se puede proyectar.`);
  const metrica = campoDe(consulta.coleccion, consulta.metrica);
  if (!metrica || !metricaSumable(consulta.coleccion, consulta.metrica)) {
    throw new Error(
      `"${consulta.metrica}" no es una métrica que se pueda sumar por mes en ${consulta.coleccion}. ` +
        `Usa: ${camposDe(consulta.coleccion)
          .filter((c) => metricaSumable(consulta.coleccion, c.campo))
          .map((c) => c.campo)
          .join(", ")}.`
    );
  }
  if (consulta.agruparPor && !campoPermitido(consulta.coleccion, consulta.agruparPor)) {
    throw new Error(`"${consulta.agruparPor}" no es un campo por el que se pueda agrupar en ${consulta.coleccion}.`);
  }
  const agruparPor = consulta.agruparPor ?? null;
  if (consulta.hastaMes && !MES_RE.test(consulta.hastaMes)) {
    throw new Error(`hastaMes debe ser AAAA-MM (recibido "${consulta.hastaMes}").`);
  }

  await connectDB();
  if (consulta.coleccion === "sapSales" || consulta.coleccion === "sapSalesLotes") {
    await asegurarFacturasFrescas();
  }
  const { filtro, ignorados } = construirFiltro(consulta);

  // Una serie que no separa por cuenta puede sumar retailers con datos hasta
  // meses distintos: se guardan las cuentas de cada mes para marcar como
  // incompletos los meses a los que les falta alguna.
  const tieneCuenta = campoPermitido(consulta.coleccion, "account");
  const conCuentas = tieneCuenta && agruparPor !== "account";

  // Una pasada: por grupo y mes, la suma, el primer y último día con datos
  // del mes y las fechas extremas. Las fechas de retail van a medianoche UTC
  // y $dateToString/$dayOfMonth también trabajan en UTC.
  const filas = await modeloDe(consulta.coleccion).aggregate<{
    _id: { grupo: unknown; mes: string };
    valor: number;
    primerDia: number;
    ultimoDia: number;
    primeraFecha: Date;
    ultimaFecha: Date;
    cuentas?: string[];
  }>([
    { $match: filtro },
    {
      $group: {
        _id: {
          grupo: agruparPor ? `$${agruparPor}` : null,
          mes: { $dateToString: { format: "%Y-%m", date: `$${fecha}` } },
        },
        valor: { $sum: `$${consulta.metrica}` },
        primerDia: { $min: { $dayOfMonth: `$${fecha}` } },
        ultimoDia: { $max: { $dayOfMonth: `$${fecha}` } },
        primeraFecha: { $min: `$${fecha}` },
        ultimaFecha: { $max: `$${fecha}` },
        ...(conCuentas ? { cuentas: { $addToSet: "$account" } } : {}),
      },
    },
    { $sort: { "_id.mes": 1 } },
  ]);

  const mesActual = mesActualMX();
  const { series, gruposOmitidos } = seriesDesdeFilas(
    filas.map((f) => ({
      grupo: f._id.grupo,
      mes: f._id.mes,
      valor: f.valor,
      primerDia: f.primerDia,
      ultimoDia: f.ultimoDia,
      primeraFecha: f.primeraFecha,
      ultimaFecha: f.ultimaFecha,
      ...(f.cuentas ? { cuentas: f.cuentas.filter((c) => c != null).map(String).sort() } : {}),
    })),
    {
      horizonte: consulta.horizonte,
      hastaMes: consulta.hastaMes,
      excluirMeses: consulta.excluirMeses,
      mesActual,
    }
  );

  return {
    metrica: consulta.metrica,
    etiqueta: metrica.etiqueta,
    mesActual,
    series,
    gruposOmitidos,
    ...(series.length === 0
      ? { aviso: "No hay ningún dato con esos filtros: revisa el retailer, el periodo o el campo filtrado." }
      : {}),
    ...(ignorados.length ? { camposIgnorados: ignorados } : {}),
  };
}
