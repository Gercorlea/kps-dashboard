import { describe, expect, it } from "vitest";
import { facetasCon } from "@/lib/catalogo/facetas";

interface Prod {
  line: string;
  status: string;
}

const porLinea = (p: Prod) => ({ id: p.line.toLowerCase(), etiqueta: p.line });
const porEstatus = (p: Prod) => ({ id: p.status.toLowerCase(), etiqueta: p.status });

const CATALOGO: Prod[] = [
  ...Array.from({ length: 20 }, () => ({ line: "Bloom", status: "Activo" })),
  ...Array.from({ length: 10 }, () => ({ line: "Bloom", status: "Descatalogado" })),
  ...Array.from({ length: 5 }, () => ({ line: "Goli", status: "Activo" })),
  ...Array.from({ length: 3 }, () => ({ line: "Goli", status: "Lanzamiento" })),
];

describe("facetasCon — el conteo sigue a los demás filtros", () => {
  it("sin filtros cuenta el catálogo entero", () => {
    const f = facetasCon(CATALOGO, CATALOGO, porLinea);
    expect(f).toEqual([
      { id: "bloom", etiqueta: "Bloom", filas: 30 },
      { id: "goli", etiqueta: "Goli", filas: 8 },
    ]);
  });

  // El caso reportado: con la línea filtrada, el menú de Estatus tiene que
  // repartir SOLO esos productos, no seguir enseñando el total de la carga.
  it("reparte entre sus opciones lo que deja el otro filtro", () => {
    const soloBloom = CATALOGO.filter((p) => p.line === "Bloom");
    const f = facetasCon(CATALOGO, soloBloom, porEstatus);

    expect(f.reduce((n, o) => n + o.filas, 0)).toBe(30);
    expect(f.find((o) => o.id === "activo")?.filas).toBe(20);
    expect(f.find((o) => o.id === "descatalogado")?.filas).toBe(10);
  });

  it("deja en cero la opción que el otro filtro vació, sin quitarla del menú", () => {
    // "Lanzamiento" sólo existe en Goli. Con Bloom filtrado tiene que seguir
    // en la lista: si desapareciera y estuviera elegida, el <select> perdería
    // su valor y el filtro se vaciaría solo.
    const soloBloom = CATALOGO.filter((p) => p.line === "Bloom");
    const f = facetasCon(CATALOGO, soloBloom, porEstatus);

    expect(f.map((o) => o.id).sort()).toEqual(["activo", "descatalogado", "lanzamiento"]);
    expect(f.find((o) => o.id === "lanzamiento")?.filas).toBe(0);
  });

  it("mantiene estable la lista de opciones aunque la búsqueda no deje nada", () => {
    const f = facetasCon(CATALOGO, [], porLinea);
    expect(f.map((o) => o.id)).toEqual(["bloom", "goli"]);
    expect(f.every((o) => o.filas === 0)).toBe(true);
  });
});

describe("facetasCon — agrupación", () => {
  it("agrupa sin distinguir mayúsculas y etiqueta con la grafía más frecuente", () => {
    // El archivo lo escribe una persona y mezcla "Activo" con "activo"; son una
    // sola opción del menú, y se muestra la forma que más aparece.
    const filas: Prod[] = [
      { line: "Bloom", status: "Activo" },
      { line: "Bloom", status: "Activo" },
      { line: "Bloom", status: "activo" },
    ];
    const f = facetasCon(filas, filas, porEstatus);
    expect(f).toEqual([{ id: "activo", etiqueta: "Activo", filas: 3 }]);
  });

  it("descarta el valor vacío: un hueco no es una opción de filtro", () => {
    const filas: Prod[] = [
      { line: "Bloom", status: "Activo" },
      { line: "", status: "Activo" },
    ];
    expect(facetasCon(filas, filas, porLinea)).toEqual([
      { id: "bloom", etiqueta: "Bloom", filas: 1 },
    ]);
  });

  it("ordena por conteo y desempata por id, para no bailar entre renders", () => {
    const filas: Prod[] = [
      { line: "Zeta", status: "x" },
      { line: "Alfa", status: "x" },
    ];
    expect(facetasCon(filas, filas, porLinea).map((o) => o.id)).toEqual(["alfa", "zeta"]);
  });
});
