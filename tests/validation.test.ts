import { describe, expect, it } from "vitest";
import { loginSchema } from "@/lib/validation/auth";
import { createUploadSchema, processUploadSchema } from "@/lib/validation/retail";

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
