import { describe, expect, it } from "vitest";
import {
  acumuladoresDeGrupos,
  agrupar,
  granularidadPorRango,
  OTROS,
  plegarTopN,
  reagruparSerie,
  rellenarSerie,
  serieTemporal,
  SIN_VALOR,
  type Acumulador,
  type GrupoAcumulado,
} from "@/lib/retail/analisis/agregar";
import type { FilaCruda, MetaColumna } from "@/lib/retail/analisis/tipos";

// El histórico agrega en Mongo y el archivo recién subido en el navegador. Para
// que las dos vistas no se desincronicen, los dos caminos terminan en los
// mismos helpers: el $group sólo produce acumuladores (suma, conteo) y el
// plegado del top-N, el bucket "Otros" y el relleno de huecos son estos.
//
// Estas pruebas fijan justo esa frontera: dados los mismos acumuladores, ambos
// caminos tienen que producir el mismo arreglo.

function col(parcial: Partial<MetaColumna> & { indice: number }): MetaColumna {
  return {
    nombre: `C${parcial.indice}`,
    tipo: "categoria",
    noVacias: 10,
    cardinalidad: 5,
    esIdentificador: false,
    esConstante: false,
    magnitud: 0,
    formatoNumerico: "nativo",
    ordenFecha: null,
    ...parcial,
  };
}

const DIM = col({ indice: 0 });
const MET = col({ indice: 1, tipo: "numero" });
const FECHA = col({ indice: 0, tipo: "fecha" });

/** Lo que devolvería un $group de Mongo sobre las mismas filas. */
function acumuladoresDe(filas: FilaCruda[]): Map<string, Acumulador> {
  const mapa = new Map<string, Acumulador>();
  for (const [clave, valor] of filas as Array<[string, number]>) {
    const acc = mapa.get(clave);
    if (acc) {
      acc.suma += valor;
      acc.conteo++;
    } else {
      mapa.set(clave, { suma: valor, conteo: 1 });
    }
  }
  return mapa;
}

describe("plegarTopN: misma salida por los dos caminos", () => {
  const filas: FilaCruda[] = [
    ["a", 10],
    ["a", 5],
    ["b", 8],
    ["c", 4],
    ["d", 3],
    ["e", 2],
  ];

  it("coincide con agrupar sobre las filas crudas", () => {
    for (const agregacion of ["suma", "promedio", "conteo"] as const) {
      for (const topN of [2, 3, 10]) {
        expect(plegarTopN(acumuladoresDe(filas), agregacion, topN)).toEqual(
          agrupar(filas, DIM, MET, agregacion, topN)
        );
      }
    }
  });

  it("en promedio, Otros es Σsuma/Σconteo y no el promedio de los promedios", () => {
    // Se pliegan c (4), d (3) y e (2): (4+3+2)/3 = 3. El promedio de los
    // promedios daría lo mismo aquí sólo porque hay una fila por grupo, así que
    // se usa un caso con conteos distintos.
    const conPesos = new Map<string, Acumulador>([
      ["a", { suma: 100, conteo: 1 }],
      ["b", { suma: 90, conteo: 1 }],
      ["c", { suma: 30, conteo: 10 }], // promedio 3
      ["d", { suma: 2, conteo: 1 }], // promedio 2
    ]);
    const otros = plegarTopN(conPesos, "promedio", 2).find((p) => p.clave === OTROS);
    expect(otros).toBeDefined();
    expect(otros?.suma).toBe(32);
    expect(otros?.conteo).toBe(11);
    expect(otros?.valor).toBeCloseTo(32 / 11); // no (3 + 2) / 2 = 2.5
    expect(otros?.gruposPlegados).toBe(2);
  });

  it("no pliega nada cuando los grupos caben en topN", () => {
    const puntos = plegarTopN(acumuladoresDe(filas), "suma", 10);
    expect(puntos).toHaveLength(5);
    expect(puntos.some((p) => p.clave === OTROS)).toBe(false);
  });

  it("agrupa el vacío en (sin valor), igual que claveDimension", () => {
    // El servidor normaliza null y "" a SIN_VALOR antes de armar el mapa; aquí
    // se comprueba que agrupar hace lo mismo con las filas crudas.
    const conVacios: FilaCruda[] = [
      ["", 1],
      [null, 2],
      ["a", 3],
    ];
    const puntos = agrupar(conVacios, DIM, MET, "suma", 10);
    expect(puntos.find((p) => p.clave === SIN_VALOR)?.suma).toBe(3);
  });
});

describe("rellenarSerie: misma salida por los dos caminos", () => {
  it("coincide con serieTemporal sobre las filas crudas", () => {
    const filas: FilaCruda[] = [
      ["2024-01-15", 5],
      ["2024-01-20", 5],
      ["2024-03-02", 7],
    ];
    const mapa = new Map<string, Acumulador>([
      ["2024-01", { suma: 10, conteo: 2 }],
      ["2024-03", { suma: 7, conteo: 1 }],
    ]);
    expect(rellenarSerie(mapa, "suma", "mes")).toEqual(
      serieTemporal(filas, FECHA, col({ indice: 1, tipo: "numero" }), "suma", "mes")
    );
  });

  it("rellena los huecos con cero en vez de saltárselos", () => {
    const mapa = new Map<string, Acumulador>([
      ["2024-01", { suma: 10, conteo: 1 }],
      ["2024-04", { suma: 4, conteo: 1 }],
    ]);
    expect(rellenarSerie(mapa, "suma", "mes")).toEqual([
      { clave: "2024-01", valor: 10 },
      { clave: "2024-02", valor: 0 },
      { clave: "2024-03", valor: 0 },
      { clave: "2024-04", valor: 4 },
    ]);
  });

  it("un mapa vacío es una serie vacía, no una serie de ceros", () => {
    expect(rellenarSerie(new Map(), "suma", "mes")).toEqual([]);
  });
});

describe("acumuladoresDeGrupos: el bundle pliega como las filas crudas", () => {
  // El servidor manda la suma de TODAS las métricas por grupo; el cliente elige
  // una sin volver a pedir nada. Esto fija que elegir la métrica B dé lo mismo
  // que habría dado agrupar las filas por la columna B.
  const METRICAS = ["posQty", "posSales"];
  const grupos: GrupoAcumulado[] = [
    { clave: "a", conteo: 2, suma: [10, 100], n: [2, 2] },
    { clave: "b", conteo: 1, suma: [3, 30], n: [1, 1] },
    { clave: "c", conteo: 1, suma: [1, 10], n: [1, 1] },
  ];
  // Las filas equivalentes: [dimensión, posQty, posSales].
  const filas: FilaCruda[] = [
    ["a", 6, 60],
    ["a", 4, 40],
    ["b", 3, 30],
    ["c", 1, 10],
  ];

  it("coincide con agrupar para cada métrica y cada agregación", () => {
    for (const [i, metrica] of METRICAS.entries()) {
      const colMet = col({ indice: i + 1, tipo: "numero" });
      for (const agregacion of ["suma", "promedio", "conteo"] as const) {
        expect(plegarTopN(acumuladoresDeGrupos(grupos, METRICAS, metrica), agregacion, 2)).toEqual(
          agrupar(filas, DIM, colMet, agregacion, 2)
        );
      }
    }
  });

  it("sin métrica cuenta filas, igual que la métrica sintética", () => {
    expect(plegarTopN(acumuladoresDeGrupos(grupos, METRICAS, null), "suma", 10)).toEqual(
      agrupar(filas, DIM, null, "suma", 10)
    );
  });

  it("el promedio divide entre las filas con métrica legible, no entre todas", () => {
    // Es el motivo de mandar `n` aparte de `conteo`: aquí el grupo tiene 4
    // filas pero sólo 2 traen la métrica. Dividir entre 4 daría 5 en vez de 10.
    const conHuecos: GrupoAcumulado[] = [{ clave: "a", conteo: 4, suma: [20], n: [2] }];
    const filasConHuecos: FilaCruda[] = [
      ["a", 12],
      ["a", 8],
      ["a", null],
      ["a", "no numérico"],
    ];
    const mapa = acumuladoresDeGrupos(conHuecos, ["m"], "m");
    expect(plegarTopN(mapa, "promedio", 10)).toEqual(
      agrupar(filasConHuecos, DIM, col({ indice: 1, tipo: "numero" }), "promedio", 10)
    );
    expect(plegarTopN(mapa, "promedio", 10)[0].valor).toBe(10);
  });

  it("una métrica que el servidor no mandó no produce NaN", () => {
    const puntos = plegarTopN(acumuladoresDeGrupos(grupos, METRICAS, "inexistente"), "suma", 10);
    expect(puntos.every((p) => Number.isFinite(p.valor))).toBe(true);
  });
});

describe("reagruparSerie", () => {
  it("mensual → anual suma lo mismo que agrupar por año desde el principio", () => {
    const filas: FilaCruda[] = [
      ["2024-02-10", 5],
      ["2024-11-01", 7],
      ["2025-03-04", 2],
    ];
    const mensual = new Map<string, Acumulador>([
      ["2024-02", { suma: 5, conteo: 1 }],
      ["2024-11", { suma: 7, conteo: 1 }],
      ["2025-03", { suma: 2, conteo: 1 }],
    ]);
    expect(rellenarSerie(reagruparSerie(mensual, 4), "suma", "anio")).toEqual(
      serieTemporal(filas, FECHA, col({ indice: 1, tipo: "numero" }), "suma", "anio")
    );
  });

  it("diario → mensual fusiona los días del mismo mes", () => {
    const diaria = new Map<string, Acumulador>([
      ["2024-02-10", { suma: 5, conteo: 1 }],
      ["2024-02-28", { suma: 3, conteo: 2 }],
      ["2024-03-01", { suma: 1, conteo: 1 }],
    ]);
    expect([...reagruparSerie(diaria, 7)]).toEqual([
      ["2024-02", { suma: 8, conteo: 3 }],
      ["2024-03", { suma: 1, conteo: 1 }],
    ]);
  });
});

describe("granularidadPorRango", () => {
  const dias = (n: number) => new Date(2024, 0, 1 + n);

  it("usa los mismos umbrales que la versión sobre filas", () => {
    expect(granularidadPorRango(dias(0), dias(59))).toBe("dia");
    expect(granularidadPorRango(dias(0), dias(60))).toBe("mes");
    // El reporte de Walmart abarca 734 días: tiene que caer en mes, no en año.
    expect(granularidadPorRango(dias(0), dias(734))).toBe("mes");
    expect(granularidadPorRango(dias(0), dias(1825))).toBe("anio");
  });

  it("con un umbral más generoso, un trimestre se ve día a día", () => {
    // El filtro de periodo de la ficha pasa 130: con los 60 de siempre, pedir
    // un trimestre (~90 días) dejaba una serie de tres puntos.
    expect(granularidadPorRango(dias(0), dias(90), 130)).toBe("dia");
    expect(granularidadPorRango(dias(0), dias(90))).toBe("mes");
    // Y un semestre sigue siendo mensual con los dos umbrales.
    expect(granularidadPorRango(dias(0), dias(182), 130)).toBe("mes");
  });
});
