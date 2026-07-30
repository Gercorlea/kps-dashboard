import { describe, expect, it } from "vitest";
import {
  derivarFechaCorte,
  normHeader,
  parseHeaderDate,
  toCode,
  toCodigoTienda,
  toNumber,
} from "@/lib/retail/normalize";

describe("normHeader (Trampa 3: espacios sobrantes)", () => {
  it("recorta y colapsa espacios", () => {
    expect(normHeader("Num Proveedor ")).toBe("Num Proveedor");
    expect(normHeader("  Nivel de  inventario ")).toBe("Nivel de inventario");
  });
});

describe("toNumber (§7.5: ausente ≠ 0)", () => {
  it("trata ND, -, y vacío como null, no como 0", () => {
    expect(toNumber("ND")).toBeNull();
    expect(toNumber("-")).toBeNull();
    expect(toNumber("")).toBeNull();
    expect(toNumber(null)).toBeNull();
    expect(toNumber(undefined)).toBeNull();
  });

  it("conserva el cero como cero", () => {
    expect(toNumber(0)).toBe(0);
    expect(toNumber("0")).toBe(0);
  });

  it("coacciona strings numéricos", () => {
    expect(toNumber("1,234")).toBe(1234);
    expect(toNumber("169")).toBe(169);
    expect(toNumber("abc")).toBeNull();
  });
});

describe("toCode / toCodigoTienda (Trampa 5)", () => {
  it("el float de CEDIS se trunca a string de entero", () => {
    expect(toCode(70006147.0)).toBe("70006147");
    expect(toCode("70006147.0")).toBe("70006147");
  });

  it("Ubic. entero gana su cero a la izquierda", () => {
    expect(toCodigoTienda(141)).toBe("0141");
    expect(toCodigoTienda("0141")).toBe("0141");
  });
});

describe("parseHeaderDate (Trampa 2)", () => {
  it("acepta Date real de Excel (CEDIS)", () => {
    const d = parseHeaderDate(new Date(Date.UTC(2026, 4, 12)));
    expect(d?.toISOString()).toBe("2026-05-12T00:00:00.000Z");
  });

  it("parsea dd.mm.yyyy manualmente, incluyendo días > 12", () => {
    // new Date("13.05.2026") daría Invalid Date en V8: por eso el parseo manual
    expect(parseHeaderDate("13.05.2026")?.toISOString()).toBe("2026-05-13T00:00:00.000Z");
    expect(parseHeaderDate("05.05.2026")?.toISOString()).toBe("2026-05-05T00:00:00.000Z");
    expect(parseHeaderDate("31.12.2026")?.toISOString()).toBe("2026-12-31T00:00:00.000Z");
  });

  it("rechaza fechas imposibles sin rollover", () => {
    expect(parseHeaderDate("32.05.2026")).toBeNull();
    expect(parseHeaderDate("05.13.2026")).toBeNull();
  });

  it("no confunde encabezados normales con fechas", () => {
    expect(parseHeaderDate("Proveedor")).toBeNull();
    expect(parseHeaderDate("Total")).toBeNull();
  });
});

describe("derivarFechaCorte (§7.4)", () => {
  it("acepta dd_mm_yyyy y dd.mm.yyyy en el nombre", () => {
    expect(
      derivarFechaCorte("KPS_COMERCIALIZADORA_12_05_2026_Trabajada.xlsx")?.toISOString()
    ).toBe("2026-05-12T00:00:00.000Z");
    expect(
      derivarFechaCorte("KPS COMERCIALIZADORA 12.05.2026 Trabajada.xlsx")?.toISOString()
    ).toBe("2026-05-12T00:00:00.000Z");
  });

  it("devuelve null si el nombre no trae fecha (la UI la exige)", () => {
    expect(derivarFechaCorte("reporte-semanal.xlsx")).toBeNull();
  });
});
