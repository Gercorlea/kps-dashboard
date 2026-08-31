import { describe, expect, it } from "vitest";
import {
  marcarParciales,
  proyectarSerie,
  seriesDesdeFilas,
  type FilaAgregada,
  type PuntoMes,
} from "@/lib/retail/pronostico-ia";

// Lo que se protege aquí: el pronóstico que KPS AI presenta como cifra sale de
// una regla que una persona puede seguir. Cada prueba fija una de esas reglas
// con una serie sintética cuya respuesta correcta se sabe de antemano.

function meses(desde: string, valores: number[]): PuntoMes[] {
  const [a0, m0] = desde.split("-").map(Number);
  return valores.map((valor, k) => {
    const i = a0 * 12 + (m0 - 1) + k;
    return { mes: `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`, valor };
  });
}

const PATRON = [100, 90, 110, 100, 120, 100, 80, 100, 100, 110, 150, 200];

describe("proyectarSerie", () => {
  it("con menos de seis meses proyecta el promedio y lo dice", () => {
    const p = proyectarSerie(meses("2026-01", [100, 120, 110]), 2);
    expect(p.metodo).toBe("promedio");
    expect(p.confianza).toBe("baja");
    expect(p.pronostico).toEqual([
      { mes: "2026-04", valor: 110 },
      { mes: "2026-05", valor: 110 },
    ]);
    expect(p.notas.join(" ")).toMatch(/Serie corta/);
  });

  it("sigue una tendencia lineal exacta", () => {
    const p = proyectarSerie(meses("2025-01", Array.from({ length: 12 }, (_, k) => 100 + 10 * k)), 3);
    expect(p.metodo).toBe("tendencia");
    expect(p.confianza).toBe("media");
    expect(p.tendenciaMensual).toBe(10);
    expect(p.nivelUltimoMesCompleto).toBe(210);
    expect(p.pronostico.map((x) => x.valor)).toEqual([220, 230, 240]);
    expect(p.totalPronostico).toBe(690);
  });

  it("una serie periódica exacta de dos años se reproduce sin pendiente espuria", () => {
    // Antes la recta cruda absorbía el pico de diciembre como crecimiento
    // (+1.36/mes) y todo 2026 salía un 22% por encima del patrón.
    for (const inicio of ["2024-01", "2024-06"]) {
      const serie = meses(inicio, [...PATRON, ...PATRON]);
      // Valor esperado: el del mismo mes calendario en la serie de entrada
      // (al arrancar en junio el patrón queda desplazado).
      const porCalendario = new Map(serie.map((p) => [p.mes.slice(5), p.valor]));
      const p = proyectarSerie(serie, 12);
      expect(p.metodo).toBe("estacional");
      expect(p.confianza).toBe("alta");
      expect(Math.abs(p.tendenciaMensual)).toBeLessThan(0.01);
      for (const punto of p.pronostico) {
        expect(punto.valor, `${inicio} → ${punto.mes}`).toBeCloseTo(porCalendario.get(punto.mes.slice(5))!, 1);
      }
      expect(p.indicesEstacionales).toHaveLength(12);
      expect(p.pruebaRetrospectiva!.metodo).toBe("estacional");
      expect(p.pruebaRetrospectiva!.errorMedioPct).toBeLessThan(1);
    }
  });

  it("recupera una tendencia real por debajo de la estacionalidad", () => {
    // Patrón × nivel que crece 1% al mes: la pendiente interanual lo ve.
    const serie = meses("2024-01", [...PATRON, ...PATRON].map((v, t) => v * (1 + 0.01 * t)));
    const p = proyectarSerie(serie, 3);
    expect(p.metodo).toBe("estacional");
    expect(p.tendenciaMensual).toBeGreaterThan(0.5);
    expect(p.pronostico[0].valor).toBeGreaterThan(PATRON[0]);
  });

  it("un mes ausente es un hueco, no cero, y se avisa", () => {
    const serie = meses("2025-01", [100, 100, 100, 100, 100, 100, 100, 100]).filter(
      (p) => p.mes !== "2025-04"
    );
    const p = proyectarSerie(serie, 1);
    expect(p.pronostico[0].valor).toBe(100);
    expect(p.notas.join(" ")).toMatch(/2025-04/);
  });

  it("excluye el mes parcial del ajuste y lo proyecta como primero del horizonte", () => {
    const serie = meses("2025-01", [100, 100, 100, 100, 100, 100, 100, 30]);
    serie[serie.length - 1].parcial = true;
    const p = proyectarSerie(serie, 2);
    expect(p.pronostico[0]).toEqual({ mes: "2025-08", valor: 100 });
    expect(p.notas.join(" ")).toMatch(/2025-08 está incompleto/);
  });

  it("nunca proyecta por debajo de cero", () => {
    const p = proyectarSerie(meses("2025-01", [60, 50, 40, 30, 20, 10]), 3);
    for (const x of p.pronostico) expect(x.valor).toBeGreaterThanOrEqual(0);
  });

  it("sin meses completos no hay nada que proyectar", () => {
    expect(() => proyectarSerie([{ mes: "2026-05", valor: 10, parcial: true }], 1)).toThrow();
  });

  it("no llama atípico al último mes de una serie con tendencia sostenida", () => {
    // Recta perfecta que cae hacia cero: el último mes es exactamente lo que
    // la tendencia predecía. Contra la mediana salía un falso -86%.
    const p = proyectarSerie(meses("2025-01", Array.from({ length: 12 }, (_, k) => 600 - 50 * k)), 1);
    expect(p.mesAtipico).toBeUndefined();
    expect(p.notas.join(" ")).not.toMatch(/atípic|por encima|por debajo/);
  });

  it("un hueco dentro de los dos años no anula la estacionalidad", () => {
    // 27 meses periódicos con enero al 160% y abril de 2025 ausente.
    const patron = [1600, ...Array(11).fill(1000)];
    const serie = meses("2024-01", [...patron, ...patron, ...patron.slice(0, 3)]).filter((p) => p.mes !== "2025-04");
    const p = proyectarSerie(serie, 12);
    expect(p.metodo).toBe("estacional");
    const enero = p.pronostico.find((x) => x.mes === "2027-01")!;
    expect(enero.valor).toBeCloseTo(1600, -1);
    expect(p.notas.join(" ")).toMatch(/04 se estimó con un solo año/);
  });

  it("interpola el factor de un mes calendario sin datos en ningún año", () => {
    const patron = [1600, ...Array(11).fill(1000)];
    const serie = meses("2024-01", [...patron, ...patron]).filter((p) => !p.mes.endsWith("-07"));
    const p = proyectarSerie(serie, 12);
    expect(p.metodo).toBe("estacional");
    expect(p.pronostico.find((x) => x.mes === "2026-07")!.valor).toBeCloseTo(1000, -1);
    expect(p.pronostico.find((x) => x.mes === "2026-01")!.valor).toBeCloseTo(1600, -1);
    expect(p.notas.join(" ")).toMatch(/Sin datos de 07 en ningún año/);
  });

  it("recupera la pendiente exacta bajo estacionalidad multiplicativa con vueltas incompletas", () => {
    // 30 meses: nivel 1000 + 20·t, patrón multiplicativo. Antes salía 19.5.
    const serie = meses("2024-01", Array.from({ length: 30 }, (_, t) => (1000 + 20 * t) * (PATRON[t % 12] / 113.33)));
    const p = proyectarSerie(serie, 3);
    expect(p.metodo).toBe("estacional");
    expect(p.tendenciaMensual).toBeCloseTo(20, 0);
  });

  it("no diverge cuando la estacionalidad tiene factores bajos (caso Walmart)", () => {
    // El ajuste re-estimaba la pendiente como diferencia interanual ENTRE el
    // factor del mes: con un verano de 0.5 la división la inflaba, la recta se
    // empinaba, el nivel se iba a negativo y los meses con tendencia <= 0 se
    // caían del cálculo de índices. En Walmart la recta acabó 3.3x por encima
    // de LOS 24 meses reales y el pronóstico de agosto (69,866) doblaba el mes
    // más alto jamás registrado (33,791).
    const VERANO_BAJO = [100, 90, 110, 100, 120, 66, 50, 68, 80, 115, 120, 116];
    const media = VERANO_BAJO.reduce((a, b) => a + b, 0) / 12;
    const serie = meses(
      "2024-06",
      Array.from({ length: 24 }, (_, t) => (1000 + 500 * t) * (VERANO_BAJO[(t + 5) % 12] / media))
    );
    const p = proyectarSerie(serie, 3);

    expect(p.metodo).toBe("estacional");
    // La recta es la real, no una empinada 3x.
    expect(p.tendenciaMensual).toBeCloseTo(500, 0);
    // Y pasa por en medio de la serie, no por encima de toda ella.
    expect(Math.abs(p.sesgoAjustePct!)).toBeLessThan(1);

    // Ningún mes proyectado se dispara por encima de lo que da la tendencia.
    const maxHistorico = Math.max(...serie.map((s) => s.valor));
    for (const punto of p.pronostico) {
      expect(punto.valor, punto.mes).toBeLessThan(maxHistorico * 1.5);
    }
  });

  it("marca el mes en curso y dice que ningún mes proyectado es real", () => {
    // El mes en curso era el único del horizonte sin `transcurrido`, así que
    // se leía como el dato real de hoy y se presentaba como "real".
    const serie = meses("2025-01", Array.from({ length: 12 }, () => 100));
    const p = proyectarSerie(serie, { horizonte: 3, mesActual: "2026-02" });

    expect(p.pronostico.map((x) => x.mes)).toEqual(["2026-01", "2026-02", "2026-03"]);
    expect(p.pronostico[0].transcurrido).toBe(true);
    expect(p.pronostico[1].enCurso).toBe(true);
    expect(p.pronostico[1].transcurrido).toBeUndefined();
    expect(p.pronostico[2].enCurso).toBeUndefined();
    expect(p.notas.join(" ")).toContain("ninguno es un dato real");
  });

  it("señala un último mes atípico (caso San Pablo) y permite excluirlo", () => {
    const serie = meses("2026-01", [100, 100, 100, 100, 100, 100, 100, 250]);
    const p = proyectarSerie(serie, 3);
    expect(p.mesAtipico).toEqual({ mes: "2026-08", desviacionPct: 150 });
    expect(p.notas.join(" ")).toMatch(/150% por encima/);
    expect(p.pronostico[0].valor).toBeGreaterThan(110); // la recta lo extrapola

    const sin = proyectarSerie(serie, { horizonte: 3, excluirMeses: ["2026-08"] });
    expect(sin.mesAtipico).toBeUndefined();
    expect(sin.ultimoMesCompleto).toBe("2026-07");
    expect(sin.pronostico[0]).toEqual({ mes: "2026-08", valor: 100 });
    expect(sin.notas.join(" ")).toMatch(/excluido a petición/);
  });

  it("hastaMes fija el horizonte por serie y marca los meses ya transcurridos", () => {
    // Walmart real: datos hasta mayo, hoy es agosto, piden hasta noviembre.
    const serie = meses("2025-06", Array(12).fill(100));
    const p = proyectarSerie(serie, { hastaMes: "2026-11", mesActual: "2026-08" });
    expect(p.ultimoMesCompleto).toBe("2026-05");
    expect(p.pronostico.map((x) => x.mes)).toEqual(["2026-06", "2026-07", "2026-08", "2026-09", "2026-10", "2026-11"]);
    expect(p.pronostico.map((x) => x.transcurrido ?? false)).toEqual([true, true, false, false, false, false]);
    expect(p.mesesDesdeUltimoDato).toBe(3);
    expect(p.notas.join(" ")).toMatch(/termina 3 meses antes/);

    const nada = proyectarSerie(serie, { hastaMes: "2026-03" });
    expect(nada.pronostico).toEqual([]);
    expect(nada.notas.join(" ")).toMatch(/Ya hay datos reales hasta 2026-05/);
  });
});

describe("prueba retrospectiva y meses parciales", () => {
  it("mide el error del método sobre los últimos meses reales", () => {
    const p = proyectarSerie(meses("2025-01", Array.from({ length: 12 }, (_, k) => 100 + 10 * k)), 1);
    expect(p.pruebaRetrospectiva!.meses).toBe(3);
    expect(p.pruebaRetrospectiva!.errorMedioPct).toBe(0);
    expect(p.confianza).toBe("media");
  });

  it("rebaja la confianza cuando el método se equivoca en la prueba", () => {
    const p = proyectarSerie(meses("2025-01", [100, 100, 100, 100, 100, 100, 100, 100, 100, 300, 300, 300]), 1);
    expect(p.pruebaRetrospectiva!.errorMedioPct).toBeGreaterThan(30);
    expect(p.confianza).toBe("baja");
  });

  it("un mes real negativo (devoluciones) no vuelve negativo el error", () => {
    const p = proyectarSerie(meses("2025-01", [100, 100, 100, 100, 100, 100, 100, 100, 100, -50, 100, 100]), 1);
    const dev = p.pruebaRetrospectiva!.detalle.find((d) => d.mes === "2025-10")!;
    expect(dev.errorPct).toBeGreaterThan(100);
    expect(p.pruebaRetrospectiva!.errorMedioPct).toBeGreaterThan(30);
  });

  it("un mes real en cero no es medible: errorPct null y no entra a la media", () => {
    const p = proyectarSerie(meses("2025-01", [100, 100, 100, 100, 100, 100, 100, 100, 100, 0, 100, 100]), 1);
    const d = p.pruebaRetrospectiva!.detalle.find((x) => x.mes === "2025-10")!;
    expect(d.errorPct).toBeNull();
    expect(p.pruebaRetrospectiva!.errorMedioPct).toBeLessThan(1);
  });

  it("si los meses de prueba son cero, la nota dice eso y no 'serie corta'", () => {
    const p = proyectarSerie(meses("2025-01", [100, 100, 100, 100, 100, 100, 100, 100, 100, 0, 0, 0]), 1);
    expect(p.pruebaRetrospectiva!.errorMedioPct).toBeNull();
    expect(p.notas.join(" ")).toMatch(/están en cero/);
    expect(p.notas.join(" ")).not.toMatch(/demasiado corta/);
  });

  it("reporta el tramo de meses completos que entró al ajuste", () => {
    const s = meses("2025-01", Array(8).fill(100));
    s[0].parcial = true;
    const p = proyectarSerie(s, 1);
    expect(p.primerMesCompleto).toBe("2025-02");
    expect(p.ultimoMesCompleto).toBe("2025-08");
    expect(p.mesesAjustados).toBe(7);
  });

  it("un mes parcial intermedio no se reporta además como hueco", () => {
    const s = meses("2025-01", Array(8).fill(100));
    s[3] = { ...s[3], valor: 30, parcial: true };
    const p = proyectarSerie(s, 1);
    expect(p.notas.join(" ")).toMatch(/2025-04 está incompleto/);
    expect(p.notas.join(" ")).not.toMatch(/Meses sin datos/);
  });

  it("no hay prueba cuando la serie no da para reservar meses", () => {
    expect(proyectarSerie(meses("2025-01", Array(7).fill(100)), 1).pruebaRetrospectiva).toBeNull();
  });

  it("marcarParciales mira cada mes: inicio tardío, fin temprano y cuentas que faltan", () => {
    const puntos: Array<PuntoMes & { cuentas?: string[] }> = [
      { mes: "2024-05", valor: 500, primerDia: 25, ultimoDia: 31 },
      { mes: "2024-06", valor: 30000, primerDia: 1, ultimoDia: 30 },
      { mes: "2024-07", valor: 2000, primerDia: 1, ultimoDia: 9 },
      { mes: "2024-08", valor: 30000, primerDia: 1, ultimoDia: 31, cuentas: ["san-pablo"] },
    ];
    const s = marcarParciales(puntos, [
      { cuenta: "san-pablo", desde: "2024-05", hasta: "2024-08", meses: 4 },
      { cuenta: "walmart", desde: "2024-05", hasta: "2024-07", meses: 3 },
    ]);
    expect(s[0].parcial).toBe(true);
    expect(s[0].motivoParcial).toMatch(/desde el día 25/);
    expect(s[1].parcial).toBeUndefined();
    expect(s[2].parcial).toBe(true);
    expect(s[2].motivoParcial).toMatch(/hasta el día 9/);
    expect(s[3].parcial).toBe(true);
    expect(s[3].motivoParcial).toMatch(/sin datos de walmart/);
  });

  it("el pronóstico arranca tras el último mes completo de ESA serie", () => {
    const p = proyectarSerie(meses("2025-06", Array(12).fill(100)), 3);
    expect(p.ultimoMesCompleto).toBe("2026-05");
    expect(p.pronostico.map((x) => x.mes)).toEqual(["2026-06", "2026-07", "2026-08"]);
  });
});

describe("seriesDesdeFilas (filas del $group → series)", () => {
  function fila(grupo: unknown, mes: string, valor: number, extra: Partial<FilaAgregada> = {}): FilaAgregada {
    return { grupo, mes, valor, primerDia: 1, ultimoDia: 30, ...extra };
  }

  it("un retailer que empieza tarde no vuelve incompletos los meses anteriores a su arranque", () => {
    // A lleva 12 meses; B sólo reporta los últimos 3. Los 9 primeros siguen
    // completos (B aún no existía) y sólo se exige B desde que empezó.
    const filas: FilaAgregada[] = Array.from({ length: 12 }, (_, k) =>
      fila(null, `2025-${String(k + 1).padStart(2, "0")}`, 100, { cuentas: k >= 9 ? ["a", "b"] : ["a"] })
    );
    const { series } = seriesDesdeFilas(filas, { horizonte: 1 });
    expect(series[0].proyeccion!.mesesAjustados).toBe(12);
    expect(series[0].cuentas).toEqual([
      { cuenta: "a", desde: "2025-01", hasta: "2025-12", meses: 12 },
      { cuenta: "b", desde: "2025-10", hasta: "2025-12", meses: 3 },
    ]);
  });

  it("una cuenta con una fila suelta no define cobertura", () => {
    const filas: FilaAgregada[] = Array.from({ length: 8 }, (_, k) =>
      fila(null, `2025-0${k + 1}`, 100, { cuentas: k === 2 ? ["a", "z"] : ["a"] })
    );
    const { series } = seriesDesdeFilas(filas, { horizonte: 1 });
    expect(series[0].proyeccion!.mesesAjustados).toBe(8);
  });

  it("una serie combinada marca incompletos los meses a los que les falta un retailer", () => {
    const filas: FilaAgregada[] = [];
    for (let m = 1; m <= 8; m++) {
      const mes = `2026-${String(m).padStart(2, "0")}`;
      filas.push(fila(null, mes, m <= 5 ? 200 : 100, { cuentas: m <= 5 ? ["san-pablo", "walmart"] : ["san-pablo"] }));
    }
    const { series } = seriesDesdeFilas(filas, { horizonte: 1 });
    expect(series).toHaveLength(1);
    expect(series[0].cuentas!.map((c) => c.cuenta)).toEqual(["san-pablo", "walmart"]);
    const p = series[0].proyeccion!;
    expect(p.ultimoMesCompleto).toBe("2026-05");
    expect(p.historico.filter((x) => x.parcial).map((x) => x.mes)).toEqual(["2026-06", "2026-07", "2026-08"]);
    expect(p.notas.join(" ")).toMatch(/sin datos de walmart/);
    expect(p.notas[0]).toMatch(/suma varios retailers con coberturas distintas/);
  });

  it("un grupo sin meses completos no tumba a los demás", () => {
    const filas: FilaAgregada[] = [
      ...Array.from({ length: 8 }, (_, k) => fila("walmart", `2026-0${k + 1}`, 100)),
      fila("heb", "2026-06", 40, { primerDia: 20, ultimoDia: 25 }),
    ];
    const { series, gruposOmitidos } = seriesDesdeFilas(filas, { horizonte: 2 });
    expect(gruposOmitidos).toBe(0);
    expect(series.map((s) => s.grupo)).toEqual(["walmart", "heb"]);
    expect(series[0].proyeccion).not.toBeNull();
    expect(series[1].proyeccion).toBeNull();
    expect(series[1].motivo).toMatch(/2026-06/);
  });

  it("ordena por volumen, respeta el tope y conserva la cobertura en días", () => {
    const filas: FilaAgregada[] = ["a", "b", "c"].flatMap((g, i) =>
      Array.from({ length: 6 }, (_, k) =>
        fila(g, `2026-0${k + 1}`, (3 - i) * 100, {
          primeraFecha: new Date(`2026-0${k + 1}-01T00:00:00.000Z`),
          ultimaFecha: new Date(`2026-0${k + 1}-28T00:00:00.000Z`),
        })
      )
    );
    const { series, gruposOmitidos } = seriesDesdeFilas(filas, { horizonte: 1, maxGrupos: 2 });
    expect(series.map((s) => s.grupo)).toEqual(["a", "b"]);
    expect(gruposOmitidos).toBe(1);
    expect(series[0].primerDiaConDatos).toBe("2026-01-01");
    expect(series[0].ultimoDiaConDatos).toBe("2026-06-28");
  });
});

describe("validaciones antes de tocar Mongo", () => {
  it("pronosticarRetail rechaza métricas no sumables, agruparPor no permitido y hastaMes mal formado", async () => {
    const { pronosticarRetail } = await import("@/lib/retail/pronostico-ia");
    await expect(pronosticarRetail({ coleccion: "salesReports", metrica: "avgPrice" })).rejects.toThrow(/no es una métrica/);
    await expect(pronosticarRetail({ coleccion: "salesReports", metrica: "posQty", agruparPor: "uploadId" })).rejects.toThrow(/agrupar/);
    await expect(pronosticarRetail({ coleccion: "salesReports", metrica: "posQty", hastaMes: "nov-2026" })).rejects.toThrow(/AAAA-MM/);
  });

  it("compararPeriodosRetail rechaza métricas no sumables y periodos inválidos", async () => {
    const { compararPeriodosRetail } = await import("@/lib/retail/crecimiento-ia");
    await expect(
      compararPeriodosRetail({ coleccion: "salesReports", metrica: "itemNbr", periodo: { desde: "2026-01-01", hasta: "2026-01-31" } })
    ).rejects.toThrow(/sumable/);
    await expect(
      compararPeriodosRetail({ coleccion: "salesReports", metrica: "posQty", periodo: { desde: "2026-02-01", hasta: "2026-01-31" } })
    ).rejects.toThrow(/termina antes/);
  });

  it("consultarRetail rechaza un sumar que no se puede sumar", async () => {
    const { consultarRetail } = await import("@/lib/retail/consultas-ia");
    await expect(
      consultarRetail({ coleccion: "salesReports", agruparPor: "brand", sumar: "avgPrice" })
    ).rejects.toThrow(/no es una métrica/);
  });
});
