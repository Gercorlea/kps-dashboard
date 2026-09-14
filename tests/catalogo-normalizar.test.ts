import { describe, expect, it } from "vitest";
import {
  clave,
  codigoNumerico,
  normalizarItem,
  parseFechaCatalogo,
} from "@/lib/catalogo/normalizar";

describe("clave (comparación de encabezados)", () => {
  it("ignora acentos, caja y espacios sobrantes", () => {
    expect(clave("  Fracción  Arancelaria ")).toBe("fraccion arancelaria");
    expect(clave("Descripción")).toBe("descripcion");
    expect(clave("Clave SAT")).toBe("clave sat");
  });

  it("colapsa la puntuación que separa palabras", () => {
    expect(clave("clave.sat")).toBe("clave sat");
    expect(clave("meses/caducidad")).toBe("meses caducidad");
  });

  it("no revienta con celdas vacías", () => {
    expect(clave(null)).toBe("");
    expect(clave(undefined)).toBe("");
    expect(clave("")).toBe("");
  });
});

describe("normalizarItem", () => {
  it("hace igual el mismo Item escrito de dos formas", () => {
    // Es la clave del cruce entre las dos hojas: si "ptal001 " y "PTAL001" no
    // colapsan, el producto se queda sin ninguna venta y nada lo explica.
    expect(normalizarItem("ptal001 ")).toBe("PTAL001");
    expect(normalizarItem(" PTAL001")).toBe("PTAL001");
  });

  it("trunca el código que Excel entregó como float", () => {
    expect(normalizarItem(70006147.0)).toBe("70006147");
  });

  it("devuelve vacío para una celda vacía", () => {
    expect(normalizarItem(null)).toBe("");
    expect(normalizarItem("   ")).toBe("");
  });
});

describe("codigoNumerico (el puente con SalesReport.itemNbr)", () => {
  it("convierte un entero completo", () => {
    expect(codigoNumerico("100436765")).toBe(100436765);
    expect(codigoNumerico(100436765)).toBe(100436765);
  });

  it("conserva el valor aunque el texto traiga cero a la izquierda", () => {
    expect(codigoNumerico("0100436765")).toBe(100436765);
  });

  it("no inventa un número cuando el código no lo es", () => {
    // Cruzar "por lo parecido" le daría a un producto las ventas de otro.
    expect(codigoNumerico("A-1004")).toBeNull();
    expect(codigoNumerico("1004.5")).toBeNull();
    expect(codigoNumerico("100436765 / 2")).toBeNull();
    expect(codigoNumerico("")).toBeNull();
    expect(codigoNumerico(null)).toBeNull();
  });

  it("rechaza lo que perdería precisión al pasar por Number", () => {
    expect(codigoNumerico("1234567890123456")).toBeNull();
    expect(codigoNumerico("123456789012345")).toBe(123456789012345);
  });
});

describe("parseFechaCatalogo", () => {
  it('lee el formato del archivo, "1-Sep-24"', () => {
    expect(parseFechaCatalogo("1-Sep-24").fecha?.toISOString()).toBe("2024-09-01T00:00:00.000Z");
  });

  it("acepta meses en español y en inglés, cortos y largos", () => {
    for (const t of ["15-ene-25", "15-enero-2025", "15-Jan-25", "15-January-2025"]) {
      expect(parseFechaCatalogo(t).fecha?.toISOString(), t).toBe("2025-01-15T00:00:00.000Z");
    }
  });

  it("da el mismo resultado con una celda Date real de Excel", () => {
    const d = parseFechaCatalogo(new Date(Date.UTC(2024, 8, 1)));
    expect(d.fecha?.toISOString()).toBe("2024-09-01T00:00:00.000Z");
  });

  it("sigue entendiendo los formatos que ya resolvía retail", () => {
    expect(parseFechaCatalogo("01.09.2024").fecha?.toISOString()).toBe("2024-09-01T00:00:00.000Z");
    expect(parseFechaCatalogo("2024-09-01").fecha?.toISOString()).toBe("2024-09-01T00:00:00.000Z");
  });

  it("conserva el texto cuando no se puede interpretar", () => {
    expect(parseFechaCatalogo("cuando salga")).toEqual({ fecha: null, texto: "cuando salga" });
  });

  it("rechaza una fecha imposible en vez de rodarla", () => {
    expect(parseFechaCatalogo("31-Feb-24").fecha).toBeNull();
    expect(parseFechaCatalogo("32-Sep-24").fecha).toBeNull();
  });

  it("no deja texto cuando la celda venía vacía", () => {
    expect(parseFechaCatalogo(null)).toEqual({ fecha: null, texto: "" });
    expect(parseFechaCatalogo("")).toEqual({ fecha: null, texto: "" });
  });
});
