import { describe, expect, it } from "vitest";
import { CatalogLoad } from "@/models/CatalogLoad";
import { CatalogProduct } from "@/models/CatalogProduct";
import { ProductMapping } from "@/models/ProductMapping";

// Los índices únicos de este módulo no son una optimización: son lo que hace
// IDEMPOTENTE el reintento de un lote. La carga se manda troceada, y si un lote
// se reenvía —porque la red falló a medias— el upsert por la clave natural
// actualiza en vez de duplicar. Quitar la unicidad no rompería ninguna pantalla
// de inmediato: duplicaría filas en silencio, que es peor.
//
// Espejo de tests/upload-indices.test.ts.

type Campos = Record<string, unknown>;

function indicePor(
  modelo: { schema: { indexes(): [Campos, Record<string, unknown> | undefined][] } },
  campos: string[]
) {
  return modelo.schema
    .indexes()
    .find(([c]) => JSON.stringify(Object.keys(c)) === JSON.stringify(campos));
}

describe("CatalogProduct", () => {
  it("tiene (loadId, item) único: es la identidad del grano", () => {
    const i = indicePor(CatalogProduct, ["loadId", "item"]);
    expect(i).toBeDefined();
    expect(i?.[1]?.unique).toBe(true);
  });

  it("lleva loadId al frente, que es lo que filtra TODA lectura del módulo", () => {
    // Una consulta sin loadId leería filas de cargas reemplazadas o a medio
    // subir, o sea datos que nadie ve en pantalla.
    for (const [campos] of CatalogProduct.schema.indexes()) {
      expect(Object.keys(campos)[0]).toBe("loadId");
    }
  });

  it("tiene un índice por UPC para el cruce inverso, y NO es único", () => {
    // Dos presentaciones pueden compartir código de barras; no es un error.
    const i = indicePor(CatalogProduct, ["loadId", "upc"]);
    expect(i).toBeDefined();
    expect(i?.[1]?.unique).toBeUndefined();
  });
});

describe("ProductMapping", () => {
  it("tiene (loadId, sku, channel) único: el mismo sku se repite por canal", () => {
    const i = indicePor(ProductMapping, ["loadId", "sku", "channel"]);
    expect(i).toBeDefined();
    expect(i?.[1]?.unique).toBe(true);
  });

  it("tiene (loadId, channel, sku) para ordenar y facetar la tabla de mapeo", () => {
    expect(indicePor(ProductMapping, ["loadId", "channel", "sku"])).toBeDefined();
  });

  it("lleva loadId al frente en todos sus índices", () => {
    for (const [campos] of ProductMapping.schema.indexes()) {
      expect(Object.keys(campos)[0]).toBe("loadId");
    }
  });
});

describe("CatalogLoad", () => {
  it("tiene loadId único", () => {
    const i = indicePor(CatalogLoad, ["loadId"]);
    expect(i).toBeDefined();
    expect(i?.[1]?.unique).toBe(true);
  });

  it("puede resolver la carga activa por índice", () => {
    // cargaActiva() es un findOne ordenado por esto y ocurre en cada lectura.
    const i = indicePor(CatalogLoad, ["status", "finalizedAt"]);
    expect(i).toBeDefined();
    expect(i?.[0].finalizedAt).toBe(-1);
  });

  it("puede barrer las cargas abandonadas por índice", () => {
    expect(indicePor(CatalogLoad, ["status", "uploadedAt"])).toBeDefined();
  });

  it("NO impone 'una sola activa' con un índice único", () => {
    // Deliberado: obligaría a desactivar la vieja antes de activar la nueva, y
    // si la segunda escritura falla el catálogo se queda en blanco. Ver el
    // comentario en models/CatalogLoad.ts.
    const activo = CatalogLoad.schema
      .indexes()
      .find(([c]) => Object.hasOwn(c, "status") && !Object.hasOwn(c, "loadId"));
    expect(activo?.[1]?.unique).toBeUndefined();
  });
});
