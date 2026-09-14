import { describe, expect, it } from "vitest";
import {
  crearCargaSchema,
  finalizarCargaSchema,
  lotesCargaSchema,
  mapeoCatalogoRowSchema,
  MAX_FILAS_LOTE_CATALOGO,
  productoCatalogoRowSchema,
} from "@/lib/validation/catalogo";

function producto(over: Record<string, unknown> = {}) {
  return {
    item: "PTAL001",
    description: "Multiblue magnesio 60 Cap / 39 g",
    status: "Activo",
    line: "bloom",
    ...over,
  };
}

function mapeo(over: Record<string, unknown> = {}) {
  return { sku: "PTAL001", channel: "walmart", ...over };
}

describe("productoCatalogoRowSchema — lo obligatorio", () => {
  it("acepta una fila con sólo los cuatro campos obligatorios", () => {
    const r = productoCatalogoRowSchema.safeParse(producto());
    expect(r.success).toBe(true);
    // El resto se rellena vacío, no ausente: el esquema de Mongo dice lo mismo.
    expect(r.data?.upc).toBe("");
    expect(r.data?.grammage).toBeNull();
    expect(r.data?.launchDate).toBeNull();
    expect(r.data?.suppliers).toEqual([]);
  });

  it("rechaza la fila sin uno de los cuatro", () => {
    for (const campo of ["item", "description", "status", "line"]) {
      expect(
        productoCatalogoRowSchema.safeParse(producto({ [campo]: "" })).success,
        campo
      ).toBe(false);
    }
  });
});

describe("productoCatalogoRowSchema — lo opcional", () => {
  it("acepta vacías todas las demás columnas", () => {
    const r = productoCatalogoRowSchema.safeParse(
      producto({
        ecom: "",
        trello: "",
        salesUnit: "",
        upc: "",
        satCode: "",
        tariffCode: "",
        suv: "",
        grammage: null,
        shelfLifeMonths: null,
        launchDate: null,
        launchDateText: "",
        suppliers: [],
      })
    );
    expect(r.success).toBe(true);
  });

  it("acepta cualquier texto en ECOM y Trello", () => {
    // No son un enum: el vocabulario lo pone quien mantiene el Excel.
    for (const v of ["si", "Sí", "NO", "ok", "OK", "NA", "pendiente"]) {
      expect(productoCatalogoRowSchema.safeParse(producto({ ecom: v, trello: v })).success, v).toBe(
        true
      );
    }
  });

  it("conserva el UPC como texto, con su cero a la izquierda", () => {
    const r = productoCatalogoRowSchema.safeParse(producto({ upc: "0750229353070" }));
    expect(r.data?.upc).toBe("0750229353070");
  });

  it("distingue el cero del ausente en Gramaje", () => {
    expect(productoCatalogoRowSchema.safeParse(producto({ grammage: 0 })).data?.grammage).toBe(0);
    expect(
      productoCatalogoRowSchema.safeParse(producto({ grammage: null })).data?.grammage
    ).toBeNull();
  });

  it("exige el formato ISO en la fecha de lanzamiento", () => {
    expect(productoCatalogoRowSchema.safeParse(producto({ launchDate: "2024-09-01" })).success).toBe(
      true
    );
    expect(productoCatalogoRowSchema.safeParse(producto({ launchDate: "1-Sep-24" })).success).toBe(
      false
    );
  });

  it("no admite más de tres proveedores", () => {
    expect(
      productoCatalogoRowSchema.safeParse(producto({ suppliers: ["a", "b", "c", "d"] })).success
    ).toBe(false);
  });
});

describe("mapeoCatalogoRowSchema", () => {
  it("exige sku y canal", () => {
    expect(mapeoCatalogoRowSchema.safeParse(mapeo({ sku: "" })).success).toBe(false);
    expect(mapeoCatalogoRowSchema.safeParse(mapeo({ channel: "" })).success).toBe(false);
  });

  it("exige que el canal venga ya como slug", () => {
    // Sin esto, "Walmart" y "walmart" serían dos canales distintos en la tabla.
    expect(mapeoCatalogoRowSchema.safeParse(mapeo({ channel: "Walmart" })).success).toBe(false);
    expect(mapeoCatalogoRowSchema.safeParse(mapeo({ channel: "san pablo" })).success).toBe(false);
    expect(mapeoCatalogoRowSchema.safeParse(mapeo({ channel: "san-pablo" })).success).toBe(true);
  });

  it("admite un canal desconocido: el slug es lo único que se exige", () => {
    expect(mapeoCatalogoRowSchema.safeParse(mapeo({ channel: "super-aki" })).success).toBe(true);
  });

  it("admite el código de cliente vacío o no numérico", () => {
    // La cadena puede no haber dado de alta el producto todavía.
    const vacio = mapeoCatalogoRowSchema.safeParse(mapeo({ customerCode: "" }));
    expect(vacio.success).toBe(true);
    expect(vacio.data?.customerCodeNum).toBeNull();

    const raro = mapeoCatalogoRowSchema.safeParse(
      mapeo({ customerCode: "A-1004", customerCodeNum: null })
    );
    expect(raro.success).toBe(true);
  });
});

describe("lotesCargaSchema", () => {
  it("distingue el lote de productos del de mapeo", () => {
    expect(lotesCargaSchema.safeParse({ tipo: "productos", filas: [producto()] }).success).toBe(
      true
    );
    expect(lotesCargaSchema.safeParse({ tipo: "mapeo", filas: [mapeo()] }).success).toBe(true);
  });

  it("no deja que una fila de mapeo se cuele como producto", () => {
    expect(lotesCargaSchema.safeParse({ tipo: "productos", filas: [mapeo()] }).success).toBe(false);
  });

  it("rechaza el lote vacío y el que pasa del tope", () => {
    expect(lotesCargaSchema.safeParse({ tipo: "productos", filas: [] }).success).toBe(false);
    const grande = Array.from({ length: MAX_FILAS_LOTE_CATALOGO + 1 }, (_, i) =>
      producto({ item: `PTAL${i}` })
    );
    expect(lotesCargaSchema.safeParse({ tipo: "productos", filas: grande }).success).toBe(false);
  });
});

describe("crearCargaSchema", () => {
  const base = { filename: "catalogo.xlsx", sizeBytes: 1024, declaredProducts: 140, declaredMappings: 300 };

  it("acepta la declaración de una carga normal", () => {
    expect(crearCargaSchema.safeParse(base).success).toBe(true);
  });

  it("rechaza una carga que declara cero productos", () => {
    // Activarla dejaría el módulo en blanco; mejor decirlo antes de escribir.
    expect(crearCargaSchema.safeParse({ ...base, declaredProducts: 0 }).success).toBe(false);
  });

  it("admite cero mapeos: una primera subida puede no traerlos", () => {
    expect(crearCargaSchema.safeParse({ ...base, declaredMappings: 0 }).success).toBe(true);
  });

  it("admite que no haya hoja de mapeo", () => {
    const r = crearCargaSchema.safeParse({ ...base, mappingSheet: null });
    expect(r.success).toBe(true);
    expect(r.data?.mappingSheet).toBeNull();
  });
});

describe("finalizarCargaSchema", () => {
  it("admite finalizar sin incidencias y sin carga previa", () => {
    const r = finalizarCargaSchema.safeParse({});
    expect(r.success).toBe(true);
    expect(r.data?.incidencias).toEqual([]);
    expect(r.data?.loadIdPrevio).toBeNull();
  });

  it("exige que la carga previa sea un uuid si se manda", () => {
    expect(finalizarCargaSchema.safeParse({ loadIdPrevio: "no-es-uuid" }).success).toBe(false);
    expect(
      finalizarCargaSchema.safeParse({ loadIdPrevio: "0189c3f0-9c1a-4f0e-8d2b-1e5a7c9d3b11" })
        .success
    ).toBe(true);
  });
});
