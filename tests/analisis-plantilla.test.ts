import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  columnasDimension,
  columnasMetrica,
  elegirDimension,
  elegirFecha,
  elegirMetrica,
  valorFecha,
  valorNumerico,
} from "@/lib/retail/analisis/inferir-tipos";
import { formatearCelda, formatearFecha } from "@/lib/retail/analisis/formato";
import {
  aplicarPlantilla,
  filasParaHistorico,
  reconocerPlantilla,
  seleccionDePlantilla,
  WALMART_MENSUAL,
} from "@/lib/retail/analisis/plantillas";
import { construirDataset, elegirHojaConDatos, leerLibro } from "@/lib/retail/analisis/parsear";
import type { Dataset } from "@/lib/retail/analisis/tipos";

// Se prueba contra el archivo REAL que exporta Walmart Retail Link, no contra
// un workbook sintético: las trampas de este reporte (26 filas de preámbulo,
// fechas "2024/07/06", UPC con cero a la izquierda, tres columnas constantes)
// sólo aparecen en el archivo de verdad.
const RUTA = path.join(
  process.cwd(),
  "src/lib/retail/analisis/Reporte mensual Walmart Prueba 05082026.xlsx"
);

let cache: Dataset | null = null;
async function plantillaWalmart(): Promise<Dataset> {
  if (cache) return cache;
  const buf = readFileSync(RUTA);
  const file = new File([new Uint8Array(buf)], path.basename(RUTA));
  const hojas = await leerLibro(file);
  cache = construirDataset(hojas, elegirHojaConDatos(hojas));
  return cache;
}

const col = (ds: Dataset, nombre: string) => {
  const c = ds.columnas.find((x) => x.nombre === nombre);
  if (!c) throw new Error(`no existe la columna ${nombre}`);
  return c;
};

describe("reporte mensual de Walmart: las trampas del archivo real", () => {
  it("encuentra el encabezado bajo las 26 filas de preámbulo", async () => {
    const ds = await plantillaWalmart();
    // Índice 26 = fila 27 de Excel, la que trae "Brand Desc".
    expect(ds.filaEncabezado).toBe(26);
    expect(ds.columnas).toHaveLength(18);
    expect(ds.columnas[0].nombre).toBe("Brand Desc");
    expect(ds.totalFilas).toBe(15344);
  });

  it('lee "Daily" como fecha pese al formato yyyy/mm/dd', async () => {
    const ds = await plantillaWalmart();
    const daily = col(ds, "Daily");
    expect(daily.tipo).toBe("fecha");
    const d = valorFecha(ds.filas[0][daily.indice], daily);
    expect(d).not.toBeNull();
    // Sin corrimiento por zona horaria: el 6 de julio sigue siendo el 6.
    expect(formatearFecha(d as Date)).toBe("2024-07-06");
  });

  it("conserva el cero inicial del UPC en vez de volverlo número", async () => {
    const ds = await plantillaWalmart();
    const upc = col(ds, "UPC");
    expect(upc.tipo).toBe("categoria");
    expect(formatearCelda(ds.filas[0][upc.indice])).toBe("0750229353070");
  });

  it("marca como constantes las columnas que el usuario pidió ignorar", async () => {
    const ds = await plantillaWalmart();
    for (const nombre of ["Vendor Name", "Vendor Nbr", "Net Net Unit Margin%"]) {
      expect(col(ds, nombre).esConstante, nombre).toBe(true);
    }
    expect(col(ds, "Item Flags").tipo).toBe("vacia");
  });

  it("ninguna columna ignorada llega a los selectores", async () => {
    const ds = await plantillaWalmart();
    const ofrecidas = [
      ...columnasDimension(ds.columnas),
      ...columnasMetrica(ds.columnas),
    ].map((c) => c.nombre);
    for (const nombre of ["Vendor Name", "Vendor Nbr", "Net Net Unit Margin%", "Item Flags"]) {
      expect(ofrecidas, nombre).not.toContain(nombre);
    }
  });

  it("no propone un código como métrica: la de por defecto es POS Sales", async () => {
    const ds = await plantillaWalmart();
    // Sin la detección de códigos ganaría UPC o Item Nbr por pura magnitud.
    expect(ds.columnas[elegirMetrica(ds.columnas)].nombre).toBe("POS Sales");
    const metricas = columnasMetrica(ds.columnas).map((c) => c.nombre);
    expect(metricas).not.toContain("Item Nbr");
    expect(metricas).not.toContain("Prime Item Nbr");
    expect(metricas).not.toContain("Product Code");
  });

  it("elige Brand Desc como dimensión y Daily como fecha", async () => {
    const ds = await plantillaWalmart();
    expect(ds.columnas[elegirDimension(ds.columnas)].nombre).toBe("Brand Desc");
    expect(ds.columnas[elegirFecha(ds.columnas)].nombre).toBe("Daily");
  });

  it("los códigos se muestran sin separadores de miles", async () => {
    const ds = await plantillaWalmart();
    const item = col(ds, "Item Nbr");
    expect(item.esIdentificador).toBe(true);
    expect(formatearCelda(ds.filas[0][item.indice], item.esIdentificador)).toBe("101252325");
    // Una métrica sí los lleva.
    const sales = col(ds, "POS Sales");
    expect(formatearCelda(1234.5, sales.esIdentificador)).toBe("1,234.50");
  });
});

describe("plantillas", () => {
  it("reconoce el layout de Walmart", async () => {
    const ds = await plantillaWalmart();
    expect(reconocerPlantilla(ds.columnas)?.id).toBe("walmart-mensual");
  });

  it("no reconoce un archivo cualquiera", () => {
    const columnas = [
      { nombre: "Fecha" },
      { nombre: "Cliente" },
      { nombre: "Importe" },
    ] as Parameters<typeof reconocerPlantilla>[0];
    expect(reconocerPlantilla(columnas)).toBeNull();
  });

  it("sigue reconociendo aunque Walmart agregue una columna nueva", async () => {
    const ds = await plantillaWalmart();
    const conExtra = [
      ...ds.columnas,
      { ...ds.columnas[0], indice: 99, nombre: "Columna Nueva" },
    ];
    expect(reconocerPlantilla(conExtra)?.id).toBe("walmart-mensual");
  });

  it("deja de reconocer si falta una columna que no se ignora", async () => {
    const ds = await plantillaWalmart();
    const sinSales = ds.columnas.filter((c) => c.nombre !== "POS Sales");
    expect(reconocerPlantilla(sinSales)).toBeNull();
  });

  it("los roles de la plantilla mandan sobre lo inferido", async () => {
    const ds = await plantillaWalmart();
    const resueltas = aplicarPlantilla(ds.columnas, WALMART_MENSUAL);
    const porNombre = (n: string) => resueltas.find((c) => c.nombre === n);

    expect(porNombre("Daily")?.rol).toBe("fecha");
    expect(porNombre("Daily")?.campo).toBe("date");
    expect(porNombre("UPC")?.rol).toBe("codigo");
    expect(porNombre("UPC")?.esIdentificador).toBe(true);
    expect(porNombre("POS Sales")?.rol).toBe("metrica");
    expect(porNombre("Vendor Name")?.rol).toBe("ignorada");
    // Marcar una ignorada como constante es lo que la saca de los selectores.
    expect(porNombre("Vendor Name")?.esConstante).toBe(true);
  });

  it("la selección por plantilla apunta a POS Sales, Brand Desc y Daily", async () => {
    const ds = await plantillaWalmart();
    const sel = seleccionDePlantilla(ds);
    expect(sel).not.toBeNull();
    expect(ds.columnas[sel!.idxMetrica].nombre).toBe("POS Sales");
    expect(ds.columnas[sel!.idxDimension].nombre).toBe("Brand Desc");
    expect(ds.columnas[sel!.idxFecha].nombre).toBe("Daily");
  });
});

describe("filas para el histórico", () => {
  it("mapea las 15 344 filas a los campos del modelo", async () => {
    const ds = await plantillaWalmart();
    const sel = seleccionDePlantilla(ds)!;
    const { filas, descartadas } = filasParaHistorico(ds, sel.columnas);

    expect(filas).toHaveLength(15344);
    expect(descartadas).toBe(0);

    expect(filas[0]).toEqual({
      brand: "BLOOM",
      primeItemNbr: 101252325,
      itemDesc: "BLOOM FRUTOS ROJOS",
      upc: "0750229353070",
      productCode: "10283710",
      wmMonth: "2024/07",
      posQty: 0,
      posSales: 0,
      avgPrice: 0,
      avgSalesPerStore: 0,
      itemQtySold: 0,
      basketOccurrences: 0,
      date: "2024-07-06",
      itemNbr: 101252325,
    });
  });

  it("no incluye ningún campo de las columnas ignoradas", async () => {
    const ds = await plantillaWalmart();
    const sel = seleccionDePlantilla(ds)!;
    const { filas } = filasParaHistorico(ds, sel.columnas);
    for (const campo of ["vendorName", "vendorNbr", "netNetUnitMarginPct", "itemFlags"]) {
      expect(Object.keys(filas[0]), campo).not.toContain(campo);
    }
  });

  it("los códigos viajan como texto y las métricas como número", async () => {
    const ds = await plantillaWalmart();
    const sel = seleccionDePlantilla(ds)!;
    const { filas } = filasParaHistorico(ds, sel.columnas);
    expect(typeof filas[0].upc).toBe("string");
    expect(typeof filas[0].productCode).toBe("string");
    expect(typeof filas[0].posSales).toBe("number");
    expect(typeof filas[0].itemNbr).toBe("number");
  });

  it("la clave natural (itemNbr, date) es única, que es lo que hace idempotente el upsert", async () => {
    const ds = await plantillaWalmart();
    const sel = seleccionDePlantilla(ds)!;
    const { filas } = filasParaHistorico(ds, sel.columnas);
    const claves = new Set(filas.map((f) => `${f.itemNbr}|${f.date}`));
    expect(claves.size).toBe(filas.length);
  });

  it("el total de POS Sales del mapeo coincide con el de la columna cruda", async () => {
    const ds = await plantillaWalmart();
    const sel = seleccionDePlantilla(ds)!;
    const { filas } = filasParaHistorico(ds, sel.columnas);
    const sales = col(ds, "POS Sales");
    const directo = ds.filas.reduce(
      (s, f) => s + (valorNumerico(f[sales.indice], sales) ?? 0),
      0
    );
    const mapeado = filas.reduce((s, f) => s + (f.posSales as number), 0);
    expect(mapeado).toBeCloseTo(directo, 2);
  });
});
