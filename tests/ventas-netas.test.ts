import { describe, expect, it } from "vitest";
import {
  casillasDelAnio,
  compararConAnioAnterior,
  faltantesDelMes,
  filasDelMes,
  rangosPorRetailer,
  variacionMes,
  type Casilla,
  type CasillaComparada,
} from "@/components/dashboard/VentasNetasChart";
import type { PuntoVentasNetas } from "@/lib/retail/stats";

function punto(periodo: string, porRetailer: Record<string, number>): PuntoVentasNetas {
  return {
    periodo,
    total: Object.values(porRetailer).reduce((t, v) => t + v, 0),
    porRetailer,
  };
}

describe("casillasDelAnio", () => {
  it("devuelve los doce meses aunque el año esté a medias", () => {
    const casillas = casillasDelAnio([punto("2026-01", { walmart: 100 })], 2026);
    expect(casillas).toHaveLength(12);
    expect(casillas.map((c) => c.mes)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(casillas[0].periodo).toBe("2026-01");
    expect(casillas[11].periodo).toBe("2026-12");
  });

  it("un mes sin reporte es null y no 0: la línea se corta, no cae al suelo", () => {
    const casillas = casillasDelAnio([punto("2026-03", { walmart: 500 })], 2026);
    expect(casillas[2].total).toBe(500);
    expect(casillas[3].total).toBeNull();
    expect(casillas[3].porRetailer).toEqual({});
  });

  // La trampa que este archivo existe para fijar: `0` es falsy, así que un
  // `punto.total ? … : null` convertiría un mes de cero ventas real en un corte.
  it("un mes que reportó cero es 0 y NO null", () => {
    const casillas = casillasDelAnio([punto("2026-02", { walmart: 0 })], 2026);
    expect(casillas[1].total).toBe(0);
    expect(casillas[1].total).not.toBeNull();
  });

  it("ignora los meses de otros años", () => {
    const casillas = casillasDelAnio(
      [punto("2025-05", { walmart: 999 }), punto("2026-05", { walmart: 111 })],
      2026
    );
    expect(casillas[4].total).toBe(111);
    expect(casillas.filter((c) => c.total !== null)).toHaveLength(1);
  });

  it("un año sin ningún dato deja las doce casillas en null", () => {
    const casillas = casillasDelAnio([punto("2024-06", { walmart: 1 })], 2026);
    expect(casillas).toHaveLength(12);
    expect(casillas.every((c) => c.total === null)).toBe(true);
  });

  it("aguanta la serie vacía", () => {
    expect(casillasDelAnio([], 2026).every((c) => c.total === null)).toBe(true);
  });
});

describe("rangosPorRetailer", () => {
  it("toma el primer y el último mes de cada retailer", () => {
    const rangos = rangosPorRetailer([
      punto("2024-05", { walmart: 10 }),
      punto("2025-01", { walmart: 20, "san-pablo": 5 }),
      punto("2026-03", { "san-pablo": 7 }),
    ]);
    expect(rangos.get("walmart")).toEqual({ primero: "2024-05", ultimo: "2025-01" });
    expect(rangos.get("san-pablo")).toEqual({ primero: "2025-01", ultimo: "2026-03" });
  });

  it("no inventa rango para quien nunca reportó", () => {
    const rangos = rangosPorRetailer([punto("2026-01", { walmart: 1 })]);
    expect(rangos.has("heb")).toBe(false);
  });

  // "2024-12" < "2025-01" como texto, que es justo el orden que se necesita.
  // Comparar como Date sería el camino a los corrimientos de zona.
  it("compara los periodos como texto y cruza bien el fin de año", () => {
    const rangos = rangosPorRetailer([
      punto("2025-01", { walmart: 1 }),
      punto("2024-12", { walmart: 1 }),
    ]);
    expect(rangos.get("walmart")).toEqual({ primero: "2024-12", ultimo: "2025-01" });
  });
});

describe("faltantesDelMes", () => {
  const ids = ["walmart", "san-pablo", "heb"];
  const serie = [
    punto("2026-01", { walmart: 10, "san-pablo": 5 }),
    punto("2026-02", { walmart: 10 }),
    punto("2026-03", { walmart: 10, "san-pablo": 5 }),
  ];
  const rangos = rangosPorRetailer(serie);
  const casillas = casillasDelAnio(serie, 2026);

  it("acusa el hueco DENTRO del rango de un retailer", () => {
    expect(faltantesDelMes(casillas[1], ids, rangos)).toEqual(["san-pablo"]);
  });

  it("no acusa a quien nunca ha reportado un peso", () => {
    // HEB no aparece en ningún mes: no es una fuente, no es un hueco. Sin esto
    // los 25 meses del histórico real dirían "falta HEB" y la nota sería ruido.
    expect(faltantesDelMes(casillas[0], ids, rangos)).toEqual([]);
    expect(faltantesDelMes(casillas[1], ids, rangos)).not.toContain("heb");
  });

  it("no acusa un mes anterior al primer reporte del retailer", () => {
    const tarde = [punto("2026-05", { walmart: 1 }), punto("2026-06", { walmart: 1, heb: 2 })];
    const r = rangosPorRetailer(tarde);
    const c = casillasDelAnio(tarde, 2026);
    // Mayo es previo al debut de HEB en junio: no le falta nada.
    expect(faltantesDelMes(c[4], ["walmart", "heb"], r)).toEqual([]);
  });

  it("devuelve vacío cuando reportaron todos", () => {
    expect(faltantesDelMes(casillas[2], ids, rangos)).toEqual([]);
  });

  // Misma trampa del 0 falsy, ahora del lado del retailer: quien reportó cero
  // reportó, y no debe salir en la lista de faltantes.
  it("un retailer que reportó cero no falta", () => {
    const conCero = [
      punto("2026-01", { walmart: 10, "san-pablo": 5 }),
      punto("2026-02", { walmart: 10, "san-pablo": 0 }),
      punto("2026-03", { walmart: 10, "san-pablo": 5 }),
    ];
    const c = casillasDelAnio(conCero, 2026);
    expect(faltantesDelMes(c[1], ids, rangosPorRetailer(conCero))).toEqual([]);
  });
});

describe("filasDelMes", () => {
  const retailers = [
    { id: "san-pablo", nombre: "San Pablo" },
    { id: "walmart", nombre: "Walmart" },
    { id: "heb", nombre: "HEB" },
  ];

  function casilla(porRetailer: Record<string, number>): Casilla {
    return {
      mes: 5,
      periodo: "2026-05",
      total: Object.values(porRetailer).reduce((t, v) => t + v, 0),
      porRetailer,
    };
  }

  // El requisito: el que más aportó va arriba, aunque en RETAILERS venga después.
  it("ordena de mayor a menor aporte, no en el orden de RETAILERS", () => {
    const filas = filasDelMes(casilla({ "san-pablo": 100_000, walmart: 1_000_000 }), retailers);
    expect(filas.map((f) => f.clave)).toEqual(["walmart", "san-pablo"]);
  });

  it("ordena los cuatro casos mezclados", () => {
    const filas = filasDelMes(
      casilla({ "san-pablo": 500, walmart: 300, heb: 900 }),
      retailers
    );
    expect(filas.map((f) => f.clave)).toEqual(["heb", "san-pablo", "walmart"]);
  });

  it("omite al retailer que no reportó", () => {
    const filas = filasDelMes(casilla({ walmart: 10 }), retailers);
    expect(filas.map((f) => f.clave)).toEqual(["walmart"]);
  });

  // Un cero es un dato, no una ausencia: aparece, y al final por ser el menor.
  it("incluye al que reportó cero, hasta abajo", () => {
    const filas = filasDelMes(casilla({ walmart: 10, heb: 0 }), retailers);
    expect(filas.map((f) => f.clave)).toEqual(["walmart", "heb"]);
  });

  it("rompe el empate por nombre para que el orden no baile", () => {
    const filas = filasDelMes(casilla({ walmart: 100, heb: 100, "san-pablo": 100 }), retailers);
    expect(filas.map((f) => f.etiqueta)).toEqual(["HEB", "San Pablo", "Walmart"]);
  });

  it("cada fila lleva el color de su retailer", () => {
    const filas = filasDelMes(casilla({ walmart: 5, "san-pablo": 9 }), retailers);
    expect(filas.every((f) => typeof f.color === "string" && f.color.length > 0)).toBe(true);
    // Colores distintos: el desglose es lo único que distingue las partes.
    expect(new Set(filas.map((f) => f.color)).size).toBe(2);
  });
});

describe("compararConAnioAnterior", () => {
  it("siempre devuelve 12 filas, aun sin año anterior", () => {
    const c = compararConAnioAnterior([punto("2024-03", { walmart: 10 })], 2024);
    expect(c.filas).toHaveLength(12);
    expect(c.anioPrevio).toBe(2023);
    expect(c.hayPrevio).toBe(false);
  });

  it("un mes sin dato en el previo es null, no 0: el fantasma se corta", () => {
    const c = compararConAnioAnterior(
      [punto("2025-01", { walmart: 5 }), punto("2026-01", { walmart: 8 })],
      2026
    );
    expect(c.filas[0].previo).toBe(5);
    expect(c.filas[1].previo).toBeNull();
  });

  // Misma trampa del `||` que ya se fija para `total`, ahora del lado del previo.
  it("un mes de cero en el previo es 0 y NO null", () => {
    const c = compararConAnioAnterior(
      [punto("2025-02", { walmart: 0 }), punto("2026-02", { walmart: 8 })],
      2026
    );
    expect(c.filas[1].previo).toBe(0);
    expect(c.filas[1].previo).not.toBeNull();
  });

  // EL test que justifica escribir esta función: compararAnios tiene la regla
  // pero no la tiene pinada. Doce meses del año pasado contra cuatro del actual
  // no puede dar una caída del 70%.
  it("los totales cuentan SÓLO los meses con dato en los dos años", () => {
    const serie = [
      ...Array.from({ length: 12 }, (_, i) =>
        punto(`2025-${String(i + 1).padStart(2, "0")}`, { walmart: 100 })
      ),
      ...Array.from({ length: 4 }, (_, i) =>
        punto(`2026-${String(i + 1).padStart(2, "0")}`, { walmart: 100 })
      ),
    ];
    const c = compararConAnioAnterior(serie, 2026);
    expect(c.mesesComparables).toBe(4);
    expect(c.totalActual).toBe(400);
    // 400 y no 1200: sólo los cuatro meses compartidos.
    expect(c.totalPrevio).toBe(400);
    expect(c.variacion).toBe(0);
  });

  it("sin meses compartidos, los tres totales son null pero hayPrevio es true", () => {
    const c = compararConAnioAnterior(
      [punto("2025-01", { walmart: 10 }), punto("2026-07", { walmart: 20 })],
      2026
    );
    expect(c.mesesComparables).toBe(0);
    expect(c.totalActual).toBeNull();
    expect(c.totalPrevio).toBeNull();
    expect(c.variacion).toBeNull();
    expect(c.hayPrevio).toBe(true);
  });

  it("un previo de cero en los meses compartidos da variacion null, no infinito", () => {
    const c = compararConAnioAnterior(
      [punto("2025-01", { walmart: 0 }), punto("2026-01", { walmart: 500 })],
      2026
    );
    expect(c.mesesComparables).toBe(1);
    expect(c.totalPrevio).toBe(0);
    expect(c.variacion).toBeNull();
    expect(Number.isFinite(c.variacion as number)).toBe(false);
  });

  it("hayPrevio es false sin año anterior y true aunque no comparta ningún mes", () => {
    expect(compararConAnioAnterior([punto("2026-01", { walmart: 1 })], 2026).hayPrevio).toBe(
      false
    );
    expect(
      compararConAnioAnterior(
        [punto("2025-09", { walmart: 1 }), punto("2026-01", { walmart: 1 })],
        2026
      ).hayPrevio
    ).toBe(true);
  });

  it("da el signo correcto en subida y en bajada", () => {
    const sube = compararConAnioAnterior(
      [punto("2025-01", { walmart: 100 }), punto("2026-01", { walmart: 150 })],
      2026
    );
    expect(sube.variacion).toBeCloseTo(0.5);
    const baja = compararConAnioAnterior(
      [punto("2025-01", { walmart: 100 }), punto("2026-01", { walmart: 40 })],
      2026
    );
    expect(baja.variacion).toBeCloseTo(-0.6);
  });

  it("no se cuela un mes de anio - 2", () => {
    const c = compararConAnioAnterior(
      [punto("2024-01", { walmart: 999 }), punto("2026-01", { walmart: 10 })],
      2026
    );
    expect(c.filas[0].previo).toBeNull();
    expect(c.hayPrevio).toBe(false);
    expect(c.mesesComparables).toBe(0);
  });

  it("aguanta la serie vacía", () => {
    const c = compararConAnioAnterior([], 2026);
    expect(c.filas).toHaveLength(12);
    expect(c.filas.every((f) => f.total === null && f.previo === null)).toBe(true);
    expect(c.hayPrevio).toBe(false);
    expect(c.totalActual).toBeNull();
  });

  // Protege la decisión de `extends Casilla`: si alguien renombra `total`, esto
  // truena antes que la gráfica.
  it("una CasillaComparada sigue sirviendo a filasDelMes", () => {
    const c = compararConAnioAnterior(
      [punto("2026-01", { walmart: 100, "san-pablo": 300 })],
      2026
    );
    const filas = filasDelMes(c.filas[0], [
      { id: "san-pablo", nombre: "San Pablo" },
      { id: "walmart", nombre: "Walmart" },
    ]);
    expect(filas.map((f) => f.clave)).toEqual(["san-pablo", "walmart"]);
  });
});

describe("variacionMes", () => {
  function fila(total: number | null, previo: number | null): CasillaComparada {
    return { mes: 1, periodo: "2026-01", total, porRetailer: {}, previo };
  }

  it("es null si falta cualquiera de los dos", () => {
    expect(variacionMes(fila(null, 100))).toBeNull();
    expect(variacionMes(fila(100, null))).toBeNull();
    expect(variacionMes(fila(null, null))).toBeNull();
  });

  it("es null si el previo es cero: sin base no hay porcentaje", () => {
    expect(variacionMes(fila(500, 0))).toBeNull();
  });

  it("calcula la fracción con signo cuando existen los dos", () => {
    expect(variacionMes(fila(150, 100))).toBeCloseTo(0.5);
    expect(variacionMes(fila(40, 100))).toBeCloseTo(-0.6);
  });

  // Un mes de cero ventas real SÍ tiene variación: -100%, no null.
  it("un actual de cero contra un previo positivo da -100%, no null", () => {
    expect(variacionMes(fila(0, 100))).toBeCloseTo(-1);
  });
});
