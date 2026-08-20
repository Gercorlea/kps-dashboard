import { describe, expect, it } from "vitest";
import { loginSchema } from "@/lib/validation/auth";
import {
  CUENTAS,
  guardarAnalisisSchema,
  historicoQuerySchema,
  resumenAnalisisQuerySchema,
} from "@/lib/validation/retail";
import { nombreRetailer, RETAILER_IDS, RETAILERS } from "@/lib/retail/retailers";

// Los esquemas de carga por hojas fijas se fueron con ese flujo: sus
// colecciones estaban vacías y la vía real de entrada es el analizador, que
// valida con `guardarAnalisisSchema`.

describe("historicoQuerySchema", () => {
  it("acepta fechas ISO y rechaza otros formatos", () => {
    expect(historicoQuerySchema.safeParse({ desde: "2026-05-12" }).success).toBe(true);
    expect(historicoQuerySchema.safeParse({ desde: "12/05/2026" }).success).toBe(false);
  });

  it("cae en san-pablo, la única cuenta que tuvo ingesta por hojas fijas", () => {
    const r = historicoQuerySchema.safeParse({});
    expect(r.success && r.data.account).toBe("san-pablo");
  });
});

describe("resumenAnalisisQuerySchema", () => {
  it("sin periodo agrega todo el histórico, que es la carga inicial", () => {
    const r = resumenAnalisisQuerySchema.safeParse({ account: "walmart", alcance: "cuenta" });
    expect(r.success).toBe(true);
    expect(r.success && r.data.desde).toBeUndefined();
    expect(r.success && r.data.hasta).toBeUndefined();
  });

  it("acepta un periodo en ISO y rechaza cualquier otro formato", () => {
    expect(
      resumenAnalisisQuerySchema.safeParse({ desde: "2026-01-01", hasta: "2026-03-31" }).success
    ).toBe(true);
    // Sin ceros a la izquierda la clave dejaría de ordenar como texto, que es
    // de lo que se fía todo el módulo.
    expect(resumenAnalisisQuerySchema.safeParse({ desde: "2026-1-1" }).success).toBe(false);
    expect(resumenAnalisisQuerySchema.safeParse({ hasta: "31/03/2026" }).success).toBe(false);
  });

  it("rechaza el rango al revés antes de llegar a Mongo", () => {
    // Un $gte mayor que el $lte no falla: devuelve cero filas, y eso se lee
    // como "este retailer no vendió nada".
    expect(
      resumenAnalisisQuerySchema.safeParse({ desde: "2026-03-31", hasta: "2026-01-01" }).success
    ).toBe(false);
    // Un solo día sí vale: es el rango de una fecha.
    expect(
      resumenAnalisisQuerySchema.safeParse({ desde: "2026-01-01", hasta: "2026-01-01" }).success
    ).toBe(true);
  });
});

describe("loginSchema", () => {
  it("valida correo y contraseña presentes", () => {
    expect(loginSchema.safeParse({ email: "a@b.com", password: "x" }).success).toBe(true);
    expect(loginSchema.safeParse({ email: "no-es-correo", password: "x" }).success).toBe(false);
    expect(loginSchema.safeParse({ email: "a@b.com", password: "" }).success).toBe(false);
  });
});

describe("retailers del analizador", () => {
  const filaValida = {
    date: "2024-07-06",
    wmMonth: "2024/07",
    brand: "MARCA",
    itemDesc: "PRODUCTO X",
    itemNbr: 101252325,
    primeItemNbr: 101252325,
    upc: "0750229353070",
    productCode: "12345",
    posQty: 3,
    posSales: 1234.5,
    avgPrice: 411.5,
    avgSalesPerStore: 617.25,
    itemQtySold: 3,
    basketOccurrences: 2,
  };
  const base = {
    template: "walmart-mensual",
    sourceFile: "reporte.xlsx",
    filas: [filaValida],
  };

  it("acepta los cuatro retailers", () => {
    expect(RETAILERS).toHaveLength(4);
    for (const r of RETAILERS) {
      expect(guardarAnalisisSchema.safeParse({ ...base, account: r.id }).success).toBe(true);
    }
  });

  it("incluye a Walmart con el id que ya está en la base", () => {
    // Cambiar este id dejaría huérfanos los reportes ya guardados.
    expect(RETAILER_IDS).toContain("walmart");
  });

  it("rechaza un retailer inventado", () => {
    // Sin el enum, un id mal escrito crearía una cuenta fantasma: los reportes
    // se guardarían sin error y no aparecerían bajo ningún retailer.
    for (const account of ["costco", "Walmart", "wal-mart", ""]) {
      expect(guardarAnalisisSchema.safeParse({ ...base, account }).success).toBe(false);
    }
  });

  it("exige el retailer: no hay valor por omisión", () => {
    expect(guardarAnalisisSchema.safeParse(base).success).toBe(false);
  });

  it("nombreRetailer traduce los ids y no esconde los desconocidos", () => {
    expect(nombreRetailer("farmacias-del-ahorro")).toBe("Farmacias del Ahorro");
    expect(nombreRetailer("heb")).toBe("HEB");
    // Una cuenta vieja en la base debe verse, no desaparecer de la pantalla.
    expect(nombreRetailer("cuenta-vieja")).toBe("cuenta-vieja");
  });

  it("no toca CUENTAS, que sigue siendo la del histórico de San Pablo", () => {
    // RETAILERS (analizador) y CUENTAS (histórico multi-corte) son listas
    // distintas a propósito: confundirlas mostraría en /retail/historico
    // cuentas de las que no hay cortes.
    expect(CUENTAS).toEqual(["san-pablo"]);
  });
});
