import { describe, expect, it } from "vitest";
import {
  COLECCIONES_RETAIL,
  camposDe,
  campoPermitido,
  construirFiltro,
} from "@/lib/retail/consultas-ia";

// Lo que este archivo protege: KPS AI sólo puede consultar lo que el catálogo
// declara, y el catálogo tiene que cubrir las colecciones VIVAS de Retail. Sin
// esto, añadir un campo al modelo o retirar una colección deja a la tool
// filtrando en silencio contra nada.

describe("catálogo de colecciones de Retail para KPS AI", () => {
  it("expone las colecciones vigentes antes que las retiradas", () => {
    expect(COLECCIONES_RETAIL.slice(0, 3)).toEqual(["salesReports", "reportImports", "sapSales"]);
  });

  it("toda colección tiene al menos un campo consultable", () => {
    for (const c of COLECCIONES_RETAIL) {
      expect(camposDe(c).length, c).toBeGreaterThan(0);
    }
  });

  it("salesReports expone las dimensiones y métricas del analizador", () => {
    const campos = new Map(camposDe("salesReports").map((c) => [c.campo, c]));
    for (const esperado of ["account", "date", "brand", "itemDesc", "posQty", "posSales"]) {
      expect(campos.has(esperado), esperado).toBe(true);
    }
    expect(campos.get("posSales")?.tipo).toBe("numero");
    expect(campos.get("date")?.tipo).toBe("fecha");
    // Etiqueta de negocio, no el nombre del campo: es lo que el modelo debe decir.
    expect(campos.get("posSales")?.etiqueta).not.toBe("posSales");
  });

  it("nunca expone referencias internas", () => {
    for (const c of COLECCIONES_RETAIL) {
      const nombres = camposDe(c).map((x) => x.campo);
      for (const interno of ["_id", "__v", "uploadId", "importedBy", "docEntry", "lineNum"]) {
        expect(nombres, `${c}.${interno}`).not.toContain(interno);
      }
    }
  });

  it("la whitelist es por colección, no global", () => {
    expect(campoPermitido("salesReports", "brand")).toBe(true);
    expect(campoPermitido("sapSales", "brand")).toBe(false);
    expect(campoPermitido("sapSales", "cardName")).toBe(true);
  });

  it("las colecciones retiradas derivan sus campos del schema", () => {
    const campos = camposDe("sales").map((c) => c.campo);
    expect(campos).toContain("units");
    expect(campos).toContain("brand");
    expect(campos).not.toContain("uploadId");
  });
});

describe("construirFiltro", () => {
  it("convierte fechas ISO a Date para que Mongo compare tipos iguales", () => {
    const { filtro } = construirFiltro({
      coleccion: "salesReports",
      filtros: [{ field: "date", operador: "mayorQue", value: "2026-03-01" }],
    });
    expect(filtro.date).toEqual({ $gt: new Date("2026-03-01T00:00:00.000Z") });
  });

  it("escapa el texto de `contiene` y busca sin distinguir mayúsculas", () => {
    const { filtro } = construirFiltro({
      coleccion: "salesReports",
      filtros: [{ field: "itemDesc", operador: "contiene", value: "GOLI (60)" }],
    });
    expect(filtro.itemDesc).toEqual({ $regex: "GOLI \\(60\\)", $options: "i" });
  });

  it("informa los campos que no aplican en vez de ignorarlos en silencio", () => {
    const { filtro, ignorados } = construirFiltro({
      coleccion: "sapSales",
      filtros: [
        { field: "brand", operador: "igual", value: "ACME" },
        { field: "cardName", operador: "igual", value: "FARMACIA" },
      ],
    });
    expect(ignorados).toEqual(["brand"]);
    expect(filtro).toEqual({ cardName: "FARMACIA" });
  });
});

describe("CONTEXTO_RETAIL (lo que el modelo sabe antes de consultar)", () => {
  it("nombra todos los retailers y todas las colecciones vigentes con sus campos", async () => {
    const { CONTEXTO_RETAIL } = await import("@/lib/retail/contexto-ia");
    const { RETAILERS } = await import("@/lib/retail/retailers");
    for (const r of RETAILERS) expect(CONTEXTO_RETAIL).toContain(`${r.id} = ${r.nombre}`);
    for (const c of ["salesReports", "reportImports", "sapSales"] as const) {
      expect(CONTEXTO_RETAIL).toContain(`- ${c} — VIGENTE`);
      for (const campo of camposDe(c)) {
        expect(CONTEXTO_RETAIL, `${c}.${campo.campo}`).toContain(`${campo.campo} = ${campo.etiqueta}`);
      }
    }
  });

  it("es estático: no consulta la base ni mira el reloj (va en el prefijo cacheado del prompt)", async () => {
    const { readFileSync } = await import("node:fs");
    const fuente = readFileSync("src/lib/retail/contexto-ia.ts", "utf-8");
    expect(fuente).not.toMatch(/connectDB|mongoose|new Date\(|Date\.now/);
    const { CONTEXTO_RETAIL } = await import("@/lib/retail/contexto-ia");
    expect(CONTEXTO_RETAIL).not.toMatch(/\d+ documentos/);
  });
});

describe("construirFiltro: rangos y métricas sumables", () => {
  it("mayorQue + menorQue sobre el mismo campo forman UN rango", () => {
    const { filtro } = construirFiltro({
      coleccion: "salesReports",
      filtros: [
        { field: "date", operador: "mayorQue", value: "2026-02-28" },
        { field: "date", operador: "menorQue", value: "2026-04-01" },
        { field: "account", operador: "igual", value: "walmart" },
      ],
    });
    expect(filtro).toEqual({
      account: "walmart",
      date: { $gt: new Date("2026-02-28T00:00:00.000Z"), $lt: new Date("2026-04-01T00:00:00.000Z") },
    });
  });

  it("un igual sobre el mismo campo manda sobre el rango", () => {
    const { filtro } = construirFiltro({
      coleccion: "salesReports",
      filtros: [
        { field: "posQty", operador: "mayorQue", value: 10 },
        { field: "posQty", operador: "igual", value: 5 },
      ],
    });
    expect(filtro).toEqual({ posQty: 5 });
  });

  it("los precios promedio y los códigos no se pueden sumar", async () => {
    const { metricaSumable } = await import("@/lib/retail/consultas-ia");
    expect(metricaSumable("salesReports", "posSales")).toBe(true);
    expect(metricaSumable("salesReports", "avgPrice")).toBe(false);
    expect(metricaSumable("salesReports", "itemNbr")).toBe(false);
    expect(metricaSumable("sapSales", "docNum")).toBe(false);
    expect(metricaSumable("sapSales", "lineTotal")).toBe(true);
  });
});
