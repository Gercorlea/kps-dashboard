import { describe, expect, it } from "vitest";
import { tonoEstatus } from "@/lib/catalogo/estatus";

describe("tonoEstatus — el vocabulario en uso", () => {
  it("asigna un tono a cada uno de los cuatro estatus", () => {
    expect(tonoEstatus("Activo")).toBe("ok");
    expect(tonoEstatus("Lanzamiento")).toBe("warn");
    expect(tonoEstatus("Desarrollo")).toBe("ai");
    expect(tonoEstatus("Descatalogado")).toBe("danger");
  });

  it("no repite tono entre estatus: cada uno se distingue del resto", () => {
    const tonos = ["Activo", "Lanzamiento", "Desarrollo", "Descatalogado"].map(tonoEstatus);
    expect(new Set(tonos).size).toBe(tonos.length);
  });

  it("tolera acentos, caja y espacios sobrantes", () => {
    expect(tonoEstatus("  ACTIVO  ")).toBe("ok");
    expect(tonoEstatus("descatalogado")).toBe("danger");
    expect(tonoEstatus("LANZAMIENTO")).toBe("warn");
  });
});

describe("tonoEstatus — lo que queda fuera", () => {
  // Con reconocimiento por subcadena, "inactivo" calzaría con "activo" y un
  // producto dado de baja saldría en verde. La igualdad exacta lo impide, y
  // este test es lo que evita que alguien "mejore" el matcher y lo reintroduzca.
  it("NO confunde «Inactivo» con «Activo»", () => {
    expect(tonoEstatus("Inactivo")).toBe("neutro");
    expect(tonoEstatus("INACTIVO")).toBe("neutro");
  });

  it("deja en neutro un estatus fuera del vocabulario, sin inventarle color", () => {
    // Se sigue viendo con su texto en la tabla; sólo va sin color.
    expect(tonoEstatus("Prelanzamiento")).toBe("neutro");
    expect(tonoEstatus("En desarrollo")).toBe("neutro");
    expect(tonoEstatus("Agotado")).toBe("neutro");
  });

  it("no revienta con el estatus vacío", () => {
    expect(tonoEstatus("")).toBe("neutro");
    expect(tonoEstatus("   ")).toBe("neutro");
  });
});
