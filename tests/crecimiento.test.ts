import { describe, expect, it } from "vitest";
import { compararGrupos, periodoAnterior } from "@/lib/retail/crecimiento-ia";

describe("periodoAnterior", () => {
  it("el inmediatamente anterior tiene la misma duración", () => {
    expect(periodoAnterior({ desde: "2026-03-01", hasta: "2026-03-31" }, "anterior")).toEqual({
      desde: "2026-01-29",
      hasta: "2026-02-28",
    });
    expect(periodoAnterior({ desde: "2026-08-01", hasta: "2026-08-31" }, "anterior")).toEqual({
      desde: "2026-07-01",
      hasta: "2026-07-31",
    });
  });

  it("el mismo tramo del año pasado", () => {
    expect(periodoAnterior({ desde: "2026-03-01", hasta: "2026-03-31" }, "anioAnterior")).toEqual({
      desde: "2025-03-01",
      hasta: "2025-03-31",
    });
  });

  it("rechaza fechas mal formadas o invertidas", () => {
    expect(() => periodoAnterior({ desde: "2026-13-01", hasta: "2026-03-31" }, "anterior")).toThrow();
    expect(() => periodoAnterior({ desde: "2026-03-31", hasta: "2026-03-01" }, "anterior")).toThrow();
  });
});

describe("compararGrupos", () => {
  const actual = new Map<string | null, number>([["A", 150], ["B", 80], ["C", 40]]);
  const anterior = new Map<string | null, number>([["A", 100], ["B", 100], ["D", 20]]);

  it("calcula diferencia y % por grupo y en total, con los grupos de ambos lados", () => {
    const r = compararGrupos(actual, anterior);
    expect(r.grupos).toBe(4);
    const a = r.filas.find((f) => f.grupo === "A")!;
    expect(a).toEqual({ grupo: "A", actual: 150, anterior: 100, diferencia: 50, crecimientoPct: 50 });
    const d = r.filas.find((f) => f.grupo === "D")!;
    expect(d).toEqual({ grupo: "D", actual: 0, anterior: 20, diferencia: -20, crecimientoPct: -100 });
    expect(r.totales).toEqual({ grupo: null, actual: 270, anterior: 220, diferencia: 50, crecimientoPct: 22.73 });
  });

  it("sin base anterior el % es null y va al final del ranking de crecimiento", () => {
    const r = compararGrupos(actual, anterior, { ordenarPor: "crecimiento" });
    expect(r.filas.map((f) => f.grupo)).toEqual(["A", "B", "D", "C"]);
    expect(r.filas.find((f) => f.grupo === "C")!.crecimientoPct).toBeNull();
  });

  it("ordena por actual por defecto y respeta el límite", () => {
    const r = compararGrupos(actual, anterior, { limite: 2 });
    expect(r.filas.map((f) => f.grupo)).toEqual(["A", "B"]);
    expect(r.grupos).toBe(4);
  });
});
