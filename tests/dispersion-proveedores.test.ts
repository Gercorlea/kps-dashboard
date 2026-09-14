import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { crearExcelDispersion, type FilaDispersion } from "@/lib/proveedores/dispersion";

describe("archivo de dispersión", () => {
  it("incluye identidad, banco, importe y fechas de la liberación", async () => {
    const fila: FilaDispersion = {
      folioPortal: "FAC-2026-001",
      facturaSap: 123,
      codigoProveedor: "P0001",
      proveedor: "Proveedor de prueba",
      rfc: "AAA010101AAA",
      banco: "Banco prueba",
      cuenta: "123456",
      clabe: "012345678901234567",
      moneda: "MXN",
      importe: "1500.25",
      liberadaEl: "2026-09-14T16:00:00.000Z",
      vencimiento: "2026-10-14T16:00:00.000Z",
      datosBancariosCompletos: true,
      estado: "REGISTRADA_SAP",
    };
    const libro = XLSX.read(await crearExcelDispersion([fila]), { type: "array" });
    const datos = XLSX.utils.sheet_to_json<Record<string, unknown>>(libro.Sheets["Dispersión"])[0];
    expect(datos).toMatchObject({
      "Folio portal": "FAC-2026-001",
      "Código proveedor": "P0001",
      Banco: "Banco prueba",
      CLABE: "012345678901234567",
      Importe: 1500.25,
      "Liberada el": "2026-09-14",
    });
  });
});
