import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { parseWorkbook } from "@/lib/retail/parse-workbook";

// Workbooks sintéticos que reproducen las seis trampas del §7.1.

type Fila = unknown[];

function libro(hojas: Record<string, Fila[]>): Buffer {
  const wb = XLSX.utils.book_new();
  for (const [name, aoa] of Object.entries(hojas)) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa, { cellDates: true }), name);
  }
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx", cellDates: true }) as Buffer;
}

const DIMS_VENTAS = [
  "Ubic.",
  "Nombre de Farmacias",
  "Prod.",
  "ID",
  "Descripción",
  "Num Proveedor ", // Trampa 3: espacio final incluido
  "Proveedor",
  "División",
];

describe("Trampa 1: tablas dinámicas plantadas a la derecha", () => {
  it("ignora por completo las columnas del pivot", () => {
    const buf = libro({
      VENTAS: [
        [...DIMS_VENTAS, "05.05.2026", "13.05.2026", null, "Etiquetas de fila", "Suma de unidades"],
        [141, "AV. CHALMA", 70890001, "14170890001", "GOLI GOMITAS", 10913, "KPS", "SPN", 3, 5, null, "GOLI", 8],
      ],
    });
    const sheet = parseWorkbook(buf).hojas.find((h) => h.tipo === "sales")!;
    expect(sheet.read).toBe(1);
    expect(sheet.docs).toHaveLength(2); // solo las 2 fechas reales
    for (const doc of sheet.docs) {
      expect(Object.keys(doc)).not.toContain("Etiquetas de fila");
    }
  });
});

describe("Trampa 2: fechas dd.mm.yyyy con día > 12", () => {
  it("desnormaliza con la fecha correcta (formato largo §6.1)", () => {
    const buf = libro({
      VENTAS: [
        [...DIMS_VENTAS, "13.05.2026"],
        [141, "AV. CHALMA", 70890001, "14170890001", "GOLI GOMITAS", 10913, "KPS", "SPN", 7],
      ],
    });
    const sheet = parseWorkbook(buf).hojas.find((h) => h.tipo === "sales")!;
    const doc = sheet.docs[0] as { date: Date; units: number };
    expect(doc.date.toISOString()).toBe("2026-05-13T00:00:00.000Z");
    expect(doc.units).toBe(7);
  });
});

describe("Trampa 3: encabezados con espacios sobrantes", () => {
  it("'Num Proveedor ' se mapea igual que 'Num Proveedor'", () => {
    const buf = libro({
      VENTAS: [
        [...DIMS_VENTAS, "05.05.2026"],
        [141, "AV. CHALMA", 70890001, "14170890001", "GOLI GOMITAS", 10913, "KPS", "SPN", 1],
      ],
    });
    const sheet = parseWorkbook(buf).hojas.find((h) => h.tipo === "sales")!;
    expect((sheet.docs[0] as { vendorCode: string }).vendorCode).toBe("10913");
    expect(sheet.issues.some((i) => i.field === "vendorCode")).toBe(false);
  });
});

describe("Trampa 4: columna con el mes hardcodeado (Fill Rate)", () => {
  it("mapea 'Fecha de entrega <Mes>' por prefijo", () => {
    const buf = libro({
      "Fill Rate": [
        [
          "Documento compras", "Posición", "Proveedor", "Nombre de Proveedor", "Artículo",
          "Texto breve", "División", "Fecha de pedido", "Cantidad de reparto",
          "Unidad medida pedido", "Cantidad entregada", "Fecha de entrega Agosto",
          "Fill Rate", "Estatus de OC", "Negociador", "Pedido en UMA", "CI Docto Compras", "CPFR",
        ],
        [
          "7000179223", 10, 10913, "KPS", 70000781, "MULTIBLUE MULTIVIT", "SPN",
          new Date(Date.UTC(2026, 3, 6)), 29, "UN", 29, new Date(Date.UTC(2026, 3, 7)),
          1, "Cerrada", "ANGELICA CRUZ", 29, "ZCNB", "No",
        ],
      ],
    });
    const sheet = parseWorkbook(buf).hojas.find((h) => h.tipo === "fillRate")!;
    const doc = sheet.docs[0] as { deliveryDate: Date | null; fillRate: number };
    expect(doc.deliveryDate?.toISOString()).toBe("2026-04-07T00:00:00.000Z");
    expect(doc.fillRate).toBe(1); // fracción, se guarda tal cual (§7.5)
  });

  it("una columna esperada ausente registra incidencia sin tumbar la carga", () => {
    const buf = libro({
      "Fill Rate": [
        ["Documento compras", "Artículo", "Texto breve"],
        ["7000179223", 70000781, "MULTIBLUE MULTIVIT"],
      ],
    });
    const sheet = parseWorkbook(buf).hojas.find((h) => h.tipo === "fillRate")!;
    expect(sheet.read).toBe(1);
    expect(sheet.issues.some((i) => i.field === "buyer")).toBe(true);
  });
});

describe("Trampa 5: códigos con ceros a la izquierda", () => {
  it("Ubic. 141 → '0141' y SKU float → string de entero", () => {
    const buf = libro({
      VENTAS: [
        [...DIMS_VENTAS, "05.05.2026"],
        [141, "AV. CHALMA", 70890001, "14170890001", "GOLI GOMITAS", 10913, "KPS", "SPN", 2],
      ],
      CEDIS: [
        [
          "Artículo", "Texto breve de artículo", "División", "Num Proveedor ", "Proveedor",
          "Disponibilidad Real CD", "Tránsitos", "SIN CITA",
          new Date(Date.UTC(2026, 4, 12)),
          "Caracteristica de plan", "Mínimo", "Cobertura", "Punto de Pedido", "Stock Objetivo",
        ],
        [70006147.0, "AL NATURAL VIT D3", "SPN", 10913, "KPS", 325, 0, 0, 4, "21", 169, "ND", 0, 0],
      ],
    });
    const r = parseWorkbook(buf);
    const venta = r.hojas.find((h) => h.tipo === "sales")!.docs[0] as {
      storeCode: string;
      sku: string;
    };
    expect(venta.storeCode).toBe("0141");
    expect(venta.sku).toBe("70890001");

    const cedis = r.hojas.find((h) => h.tipo === "cedis")!.docs[0] as {
      sku: string;
      planCharacteristic: string;
      coverage: number | null;
      appointments: Array<{ date: Date; quantity: number }>;
    };
    expect(cedis.sku).toBe("70006147");
    expect(cedis.planCharacteristic).toBe("21"); // string, no número
    expect(cedis.coverage).toBeNull(); // "ND" → null, no 0 (§7.5)
    expect(cedis.appointments[0].quantity).toBe(4); // fechas EN MEDIO de la tabla (§7.2)
  });
});

describe("Trampa 6: filas vacías al final", () => {
  it("corta en la primera fila vacía dentro del ancho de la tabla", () => {
    const buf = libro({
      CEDIS: [
        [
          "Artículo", "Texto breve de artículo", "División", "Num Proveedor ", "Proveedor",
          "Disponibilidad Real CD", "Tránsitos", "SIN CITA",
          "Caracteristica de plan", "Mínimo", "Cobertura", "Punto de Pedido", "Stock Objetivo",
        ],
        [70006147, "AL NATURAL VIT D3", "SPN", 10913, "KPS", 325, 0, 0, "21", 169, 0, 0, 0],
        // vacía dentro del ancho, con basura del pivot a la derecha
        [null, null, null, null, null, null, null, null, null, null, null, null, null, "Total general", 99],
        [70006148, "FILA FANTASMA", "SPN", 10913, "KPS", 1, 0, 0, "21", 1, 0, 0, 0],
      ],
    });
    const sheet = parseWorkbook(buf).hojas.find((h) => h.tipo === "cedis")!;
    expect(sheet.read).toBe(1); // la fila fantasma tras el hueco no se lee
    expect((sheet.docs[0] as { sku: string }).sku).toBe("70006147");
  });
});

describe("FC_Mean: Total y Total red no son fechas ni datos (§7.2)", () => {
  it("los excluye del unpivot", () => {
    const buf = libro({
      FC_Mean: [
        [...DIMS_VENTAS, "12.05.2026", "13.05.2026", "Total", "Total red"],
        [141, "AV. CHALMA", 70890001, "14170890001", "GOLI GOMITAS", 10913, "KPS", "SPN", 0.5, 0.6, 99, 88],
      ],
    });
    const sheet = parseWorkbook(buf).hojas.find((h) => h.tipo === "fcMean")!;
    expect(sheet.docs).toHaveLength(2);
    const valores = sheet.docs.map((d) => (d as { value: number }).value);
    expect(valores).toEqual([0.5, 0.6]);
  });
});

describe("hojas no reconocidas (§7.2)", () => {
  it("se registran e ignoran sin tumbar la carga", () => {
    const buf = libro({
      "Notas del analista": [["esto", "no", "es", "data"]],
      VENTAS: [
        [...DIMS_VENTAS, "05.05.2026"],
        [141, "AV. CHALMA", 70890001, "14170890001", "GOLI GOMITAS", 10913, "KPS", "SPN", 1],
      ],
    });
    const r = parseWorkbook(buf);
    const desconocida = r.hojas.find((h) => h.name === "Notas del analista")!;
    expect(desconocida.tipo).toBeNull();
    expect(desconocida.issues[0].message).toMatch(/no mapeada/);
    expect(r.hojas.find((h) => h.tipo === "sales")!.docs).toHaveLength(1);
  });
});
