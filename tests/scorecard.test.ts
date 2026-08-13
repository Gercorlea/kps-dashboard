import { describe, expect, it } from "vitest";
import { fmtMoh, fmtPct, incVsAA, moh } from "@/lib/retail/scorecard";

describe("incVsAA (§8.1: divisor cero → —, nunca ∞)", () => {
  it("año anterior 0 o ausente devuelve null", () => {
    expect(incVsAA(100, 0)).toBeNull();
    expect(incVsAA(100, null)).toBeNull();
    expect(incVsAA(null, 100)).toBeNull();
  });

  it("calcula (actual/anterior) - 1", () => {
    expect(incVsAA(110, 100)).toBeCloseTo(0.1);
    expect(incVsAA(90, 100)).toBeCloseTo(-0.1);
  });
});

describe("moh (§8.1)", () => {
  it("units 0 o ausentes devuelve null", () => {
    expect(moh(500, 0)).toBeNull();
    expect(moh(500, null)).toBeNull();
    expect(moh(null, 100)).toBeNull();
  });

  it("inventario / unidades del mes", () => {
    expect(moh(500, 100)).toBe(5);
  });
});

describe("formato determinista", () => {
  it("null se muestra como — sin Infinity ni NaN", () => {
    expect(fmtPct(null)).toBe("—");
    expect(fmtMoh(null)).toBe("—");
    expect(fmtPct(incVsAA(100, 0))).toBe("—");
  });
});
