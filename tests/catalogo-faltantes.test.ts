import { describe, expect, it } from "vitest";
import { esVendible, productosSinAlta, type MapeoDeCanal } from "@/lib/catalogo/faltantes";

function producto(over: Partial<{ item: string; status: string }> = {}) {
  return { item: "PTAL001", status: "Activo", ...over };
}

function mapeo(over: Partial<MapeoDeCanal> = {}): MapeoDeCanal {
  return { sku: "PTAL001", customerCode: "1004", ...over };
}

/** Los items que quedan como faltantes, para no repetir el map en cada caso. */
function faltantes(productos: { item: string; status: string }[], mapeos: MapeoDeCanal[]) {
  return productosSinAlta(productos, mapeos).map((p) => p.item);
}

describe("esVendible", () => {
  it("acepta los dos estatus del universo", () => {
    expect(esVendible("Activo")).toBe(true);
    expect(esVendible("Lanzamiento")).toBe(true);
  });

  it("absorbe espacios y mayúsculas, como el resto del módulo", () => {
    expect(esVendible("  LANZAMIENTO ")).toBe(true);
  });

  it("NO acepta 'Inactivo', que contiene 'activo'", () => {
    // La trampa que obliga a comparar por igualdad exacta y no por subcadena:
    // un producto dado de baja contado como vendible saldría como hueco que hay
    // que salir a vender.
    expect(esVendible("Inactivo")).toBe(false);
  });

  it("deja fuera lo descatalogado y lo que todavía no existe", () => {
    expect(esVendible("Descatalogado")).toBe(false);
    expect(esVendible("Desarrollo")).toBe(false);
  });
});

describe("productosSinAlta", () => {
  it("sin ninguna fila de mapeo, el producto falta", () => {
    expect(faltantes([producto()], [])).toEqual(["PTAL001"]);
  });

  it("con código dado de alta, el producto sale de la lista", () => {
    expect(faltantes([producto()], [mapeo()])).toEqual([]);
  });

  it("una fila de mapeo con el código VACÍO no cuenta como alta", () => {
    // Es el caso que documenta ProductMapping: la cadena aparece en la hoja
    // pero todavía no le ha asignado un código al producto.
    expect(faltantes([producto()], [mapeo({ customerCode: "" })])).toEqual(["PTAL001"]);
  });

  it("un código de puros espacios tampoco es un alta", () => {
    expect(faltantes([producto()], [mapeo({ customerCode: "   " })])).toEqual(["PTAL001"]);
  });

  it("acepta como alta un código que no es numérico", () => {
    // "A-1004" no cruzaría con las ventas, pero aquí no se pregunta por ventas:
    // la cadena le dio un código, así que el producto está listado.
    expect(faltantes([producto()], [mapeo({ customerCode: "A-1004" })])).toEqual([]);
  });

  it("cruza aunque el sku venga con espacios o en minúsculas", () => {
    expect(faltantes([producto()], [mapeo({ sku: " ptal001 " })])).toEqual([]);
  });

  it("deja fuera del universo lo que no es vendible", () => {
    const productos = [
      producto(),
      producto({ item: "PTAL002", status: "Descatalogado" }),
      producto({ item: "PTAL003", status: "Lanzamiento" }),
    ];
    expect(faltantes(productos, [])).toEqual(["PTAL001", "PTAL003"]);
  });

  it("ignora el mapeo huérfano: el universo lo fija el catálogo", () => {
    expect(faltantes([producto()], [mapeo({ sku: "NOEXISTE" })])).toEqual(["PTAL001"]);
  });

  it("conserva el orden de entrada y los campos del producto", () => {
    const productos = [
      { item: "PTAL002", status: "Activo", description: "Goli" },
      { item: "PTAL001", status: "Activo", description: "Bloom" },
    ];
    const filas = productosSinAlta(productos, []);
    expect(filas.map((f) => f.item)).toEqual(["PTAL002", "PTAL001"]);
    expect(filas[1].description).toBe("Bloom");
  });

  it("entre dos mapeos del mismo sku basta con que uno traiga código", () => {
    expect(faltantes([producto()], [mapeo({ customerCode: "" }), mapeo()])).toEqual([]);
  });
});
