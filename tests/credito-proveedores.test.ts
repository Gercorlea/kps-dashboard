import { afterEach, describe, expect, it } from "vitest";
import { diasCreditoDe, estadoCredito, vencimientoCredito } from "@/lib/proveedores/credito";

const anterior = process.env.KPS_CREDIT_DAYS_DEFAULT;
afterEach(() => {
  if (anterior === undefined) delete process.env.KPS_CREDIT_DAYS_DEFAULT;
  else process.env.KPS_CREDIT_DAYS_DEFAULT = anterior;
});

describe("plazo de crédito del proveedor", () => {
  it("prefiere los días capturados en el expediente", () => {
    process.env.KPS_CREDIT_DAYS_DEFAULT = "30";
    expect(diasCreditoDe({ creditDays: 45, paymentTerms: "60 días" })).toBe(45);
  });

  it("lee el plazo legado y no inventa uno si falta", () => {
    delete process.env.KPS_CREDIT_DAYS_DEFAULT;
    expect(diasCreditoDe({ paymentTerms: "Crédito 60 días" })).toBe(60);
    expect(diasCreditoDe({ paymentTerms: "" })).toBeNull();
  });

  it("cuenta desde la liberación, no desde la factura", () => {
    const liberada = new Date("2026-09-14T16:00:00.000Z");
    expect(vencimientoCredito(liberada, 30).toISOString()).toBe("2026-10-14T16:00:00.000Z");
  });

  it("marca como vencido un plazo agotado", () => {
    expect(
      estadoCredito({
        inicio: "2026-08-01T00:00:00.000Z",
        vencimiento: "2026-08-31T00:00:00.000Z",
        dias: 30,
        ahora: new Date("2026-09-02T00:00:00.000Z"),
      })
    ).toMatchObject({ diasRestantes: -2, vencida: true });
  });
});
