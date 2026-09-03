import { describe, expect, it } from "vitest";
import { calcularFrescura, enriquecerFrescura } from "@/lib/sap/frescura";

const HOY = new Date("2026-08-27T00:00:00.000Z");

describe("frescura de lotes (calculada en servidor)", () => {
  it("días para vencer, desde fabricación y vida útil restante", () => {
    const f = calcularFrescura(
      { Batch: "L1", ManufacturingDate: "2026-01-01", ExpirationDate: "2026-12-31", AdmissionDate: "2026-02-01" },
      HOY
    );
    expect(f.diasParaVencer).toBe(126);
    expect(f.diasDesdeFabricacion).toBe(238);
    expect(f.diasDesdeIngreso).toBe(207);
    expect(f.vidaUtilDias).toBe(364);
    expect(f.vidaUtilRestantePct).toBeCloseTo(34.6, 1);
    expect(f.estadoFrescura).toBe("vigente");
  });

  it("clasifica por vencer (≤90 días) y caducado (negativo)", () => {
    expect(calcularFrescura({ ExpirationDate: "2026-10-01" }, HOY).estadoFrescura).toBe("por vencer");
    const c = calcularFrescura({ ExpirationDate: "2026-08-01" }, HOY);
    expect(c.estadoFrescura).toBe("caducado");
    expect(c.diasParaVencer).toBe(-26);
  });

  it("acepta fechas con hora del Service Layer y el nombre ExpiryDate", () => {
    const f = calcularFrescura({ ExpiryDate: "2026-09-26T00:00:00Z" }, HOY);
    expect(f.diasParaVencer).toBe(30);
  });

  it("no toca filas sin fechas de lote", () => {
    const filas = enriquecerFrescura([{ ItemCode: "A", ItemName: "x" }], HOY);
    expect(filas[0]).toEqual({ ItemCode: "A", ItemName: "x" });
  });
});
