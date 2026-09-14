import { describe, expect, it } from "vitest";
import { esSelloKpsValido } from "@/lib/proveedores/sello-ia";

const selloKps = {
  selloEncontrado: true,
  tipoSello: "KPS_ALMACEN" as const,
  confianza: 0.96,
  textoSello: "GROUP KPS Almacén y Logística 21 JUL 2026 RECIBIDO ALMACÉN Folio: 26 Recibió: J. Martínez",
  firmaAlmacenEncontrada: true,
  recibio: "J. Martínez",
  fechaRecibido: "21 JUL 2026",
  folioSello: "26",
  paginaSello: 1,
  piezasLeidas: 4073,
  observaciones: [],
};

describe("clasificación del sello de almacén", () => {
  it("acepta el sello GROUP KPS de recibido del documento DEP-01", () => {
    expect(esSelloKpsValido(selloKps)).toBe(true);
  });

  it("no confunde el sello de calidad del proveedor con el de almacén", () => {
    expect(
      esSelloKpsValido({
        ...selloKps,
        tipoSello: "PROVEEDOR_CALIDAD",
        textoSello: "PH&S ASEGURAMIENTO DE CALIDAD 20 JUL 2026",
      })
    ).toBe(false);
  });

  it("verifica el texto aunque el modelo etiquete incorrectamente el tipo", () => {
    expect(
      esSelloKpsValido({
        ...selloKps,
        textoSello: "PH&S ASEGURAMIENTO DE CALIDAD 20 JUL 2026",
      })
    ).toBe(false);
  });

  it("rechaza una identificación con confianza insuficiente", () => {
    expect(esSelloKpsValido({ ...selloKps, confianza: 0.55 })).toBe(false);
  });
});
