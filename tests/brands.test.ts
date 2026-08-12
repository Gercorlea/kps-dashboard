import { describe, expect, it } from "vitest";
import { derivarMarca } from "@/lib/retail/brands";

describe("derivarMarca (§7.3)", () => {
  it("MULTILYTE y MULTISPORT no caen en MULTIBLUE", () => {
    expect(derivarMarca("MULTILYTE ELECTROLITOS C/30").marca).toBe("MULTILYTE");
    expect(derivarMarca("MULTISPORT PROTEINA C/1KG").marca).toBe("MULTISPORT");
    expect(derivarMarca("MULTIBLUE MULTIVIT COLAGENO C/60CAP").marca).toBe("MULTIBLUE");
  });

  it("GOLÍ con acento cae en GOLI", () => {
    expect(derivarMarca("GOLÍ GOMITAS VINAGRE MANZANA").marca).toBe("GOLI");
    expect(derivarMarca("GOLI  WOMEN´S MULTIVITAMINICO").marca).toBe("GOLI");
  });

  it("AL NATURAL queda completa, no como AL", () => {
    const r = derivarMarca("AL NATURAL VIT D3 + K2 EFERVESC C/20TAB");
    expect(r.marca).toBe("AL NATURAL");
    expect(r.clasificada).toBe(true);
  });

  it("BOTANICAL DOCTOR y VALNAIT-DES se reconocen", () => {
    expect(derivarMarca("BOTANICAL DOCTOR TE VERDE").marca).toBe("BOTANICAL DOCTOR");
    expect(derivarMarca("VALNAIT-DES CAPSULAS").marca).toBe("VALNAIT");
  });

  it("sin match → SIN CLASIFICAR y visible como no clasificada", () => {
    const r = derivarMarca("ALUX SKIN  PARCHES PCS C/30PZS");
    expect(r.marca).toBe("SIN CLASIFICAR");
    expect(r.clasificada).toBe(false);
  });
});
