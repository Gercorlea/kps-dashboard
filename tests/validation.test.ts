import { describe, expect, it } from "vitest";
import { loginSchema } from "@/lib/validation/auth";
import {
  CUENTAS,
  createUploadSchema,
  guardarAnalisisSchema,
  processUploadSchema,
} from "@/lib/validation/retail";
import { nombreRetailer, RETAILER_IDS, RETAILERS } from "@/lib/retail/retailers";

const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

describe("createUploadSchema (§5.7)", () => {
  const base = {
    filename: "KPS_12_05_2026.xlsx",
    contentType: XLSX_MIME,
    sizeBytes: 5_000_000,
    account: "san-pablo" as const,
  };

  it("acepta un .xlsx válido", () => {
    expect(createUploadSchema.safeParse(base).success).toBe(true);
  });

  it("rechaza extensiones que no sean .xlsx", () => {
    expect(createUploadSchema.safeParse({ ...base, filename: "datos.xls" }).success).toBe(false);
    expect(createUploadSchema.safeParse({ ...base, filename: "datos.csv" }).success).toBe(false);
  });

  it("rechaza content-type incorrecto", () => {
    expect(
      createUploadSchema.safeParse({ ...base, contentType: "application/octet-stream" }).success
    ).toBe(false);
  });

  it("rechaza archivos de más de 25 MB", () => {
    expect(
      createUploadSchema.safeParse({ ...base, sizeBytes: 26 * 1024 * 1024 }).success
    ).toBe(false);
  });

  it("solo acepta cuentas conocidas (v1: san-pablo)", () => {
    expect(createUploadSchema.safeParse({ ...base, account: "walmart" }).success).toBe(false);
  });
});

describe("processUploadSchema (§7.4)", () => {
  it("exige date ISO", () => {
    expect(processUploadSchema.safeParse({ cutoffDate: "2026-05-12" }).success).toBe(true);
    expect(processUploadSchema.safeParse({ cutoffDate: "12/05/2026" }).success).toBe(false);
    expect(processUploadSchema.safeParse({}).success).toBe(false);
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

  it("no toca CUENTAS, que es del flujo de ingesta de San Pablo", () => {
    // Ampliar CUENTAS dejaría crear cargas que ese flujo no sabe procesar.
    expect(CUENTAS).toEqual(["san-pablo"]);
  });
});
