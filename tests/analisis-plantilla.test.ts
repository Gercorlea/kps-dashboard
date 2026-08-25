import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { compararAnios, valorMetricaAgregada } from "@/lib/retail/analisis/agregar";
import type { Acumulador } from "@/lib/retail/analisis/agregar";
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
  opcionesDeFiltro,
  reconocerPlantilla,
  seleccionDePlantilla,
  WALMART_MENSUAL,
} from "@/lib/retail/analisis/plantillas";
import { construirDataset, leerLibro } from "@/lib/retail/analisis/parsear";
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
  cache = construirDataset(hojas, hojas[0].nombre);
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
    // Por campo y no por nombre: el nombre visible es el que ve el cliente y
    // puede cambiar, el campo es el contrato con Mongo y no.
    const porCampo = (c: string) => resueltas.find((x) => x.campo === c);

    expect(porCampo("date")?.rol).toBe("fecha");
    expect(porCampo("date")?.nombre).toBe("Daily");
    expect(porCampo("upc")?.rol).toBe("codigo");
    expect(porCampo("upc")?.esIdentificador).toBe(true);
    expect(porCampo("posSales")?.rol).toBe("metrica");
    expect(porCampo("vendorName")?.rol).toBe("ignorada");
    // Marcar una ignorada como constante es lo que la saca de los selectores.
    expect(porCampo("vendorName")?.esConstante).toBe(true);
  });

  it("la etiqueta de la plantilla reemplaza al encabezado en inglés", async () => {
    const ds = await plantillaWalmart();
    const resueltas = aplicarPlantilla(ds.columnas, WALMART_MENSUAL);
    const nombre = (campo: string) => resueltas.find((c) => c.campo === campo)?.nombre;

    expect(nombre("brand")).toBe("Marca");
    expect(nombre("primeItemNbr")).toBe("Código del producto");
    expect(nombre("itemDesc")).toBe("Nombre del producto");
    expect(nombre("posQty")).toBe("Unidades");
    expect(nombre("posSales")).toBe("Ventas netas");
    expect(nombre("avgPrice")).toBe("Precio promedio");
    expect(nombre("avgSalesPerStore")).toBe("Venta promedio por tienda");
    // Sin etiqueta declarada se conserva el encabezado del Excel.
    expect(nombre("upc")).toBe("UPC");
  });

  it("el catálogo de filtros lo declara la plantilla, no la inferencia", async () => {
    const ds = await plantillaWalmart();
    const resueltas = aplicarPlantilla(ds.columnas, WALMART_MENSUAL);

    expect(opcionesDeFiltro(resueltas, "dimension").map((c) => c.campo)).toEqual([
      "brand",
      "primeItemNbr",
      "itemDesc",
      "upc",
    ]);
    expect(opcionesDeFiltro(resueltas, "metrica").map((c) => c.campo)).toEqual([
      "posQty",
      "posSales",
    ]);
  });

  it("el grano de la pestaña de productos apunta a columnas declaradas", async () => {
    const ds = await plantillaWalmart();
    const resueltas = aplicarPlantilla(ds.columnas, WALMART_MENSUAL);
    const producto = WALMART_MENSUAL.producto!;
    const campoDe = (campo: string) => resueltas.find((c) => c.campo === campo);

    // Identidad del producto: el nombre solo agruparía varios UPC en una fila.
    expect(producto.claves).toEqual(["itemDesc", "upc", "brand"]);
    // Las de canasta, la que duplica a POS Qty y la lectura por tienda quedan
    // fuera; se siguen guardando y se ven en /retail/analisis.
    expect(producto.metricas).toEqual(["posQty", "posSales", "avgPrice"]);
    expect(producto.metricas).not.toContain("itemQtySold");
    expect(producto.metricas).not.toContain("basketOccurrences");
    expect(producto.metricas).not.toContain("avgSalesPerStore");

    // Un campo mal escrito aquí deja la tabla sin columna o agrupa por nada, y
    // el servidor lo descartaría en silencio: se verifica que todos existan.
    for (const campo of [...producto.claves, ...producto.metricas]) {
      expect(campoDe(campo), `columna declarada: ${campo}`).toBeDefined();
      expect(campoDe(campo)?.rol).not.toBe("ignorada");
    }
    // Y que cada mitad sea de la clase que le toca.
    expect(producto.metricas.every((m) => campoDe(m)?.rol === "metrica")).toBe(true);
    expect(producto.claves.every((c) => campoDe(c)?.tipo === "categoria")).toBe(true);
  });

  it("las columnas que ya vienen promediadas no se declaran aditivas", async () => {
    const ds = await plantillaWalmart();
    const resueltas = aplicarPlantilla(ds.columnas, WALMART_MENSUAL);
    const agregado = (campo: string) => resueltas.find((c) => c.campo === campo)?.agregado;

    // Unidades e importes se suman; los dos promedios de Walmart, no. Sumarlos
    // daba un "precio promedio" de 167,618 en vez de 239.
    expect(agregado("posQty")).toEqual({ tipo: "suma" });
    expect(agregado("posSales")).toEqual({ tipo: "suma" });
    expect(agregado("avgPrice")).toEqual({
      tipo: "razon",
      numerador: "posSales",
      divisor: "posQty",
    });
    expect(agregado("avgSalesPerStore")).toEqual({ tipo: "promedio" });
  });

  it("Avg Price es exactamente POS Sales / POS Qty en el archivo real", async () => {
    // Es lo que justifica declarar la razón: el cociente de los dos totales no
    // es una aproximación del precio promedio, es el precio promedio.
    const ds = await plantillaWalmart();
    const [qty, sales, price] = ["POS Qty", "POS Sales", "Avg Price"].map((n) => col(ds, n));

    let comparadas = 0;
    for (const fila of ds.filas) {
      const q = valorNumerico(fila[qty.indice], qty);
      const v = valorNumerico(fila[sales.indice], sales);
      const p = valorNumerico(fila[price.indice], price);
      if (q === null || v === null || p === null || q === 0) continue;
      expect(Math.abs(v / q - p)).toBeLessThan(1e-6);
      comparadas++;
    }
    // Que la comparación no haya pasado de largo sobre un archivo vacío.
    expect(comparadas).toBeGreaterThan(1000);
  });

  it("cada métrica se junta como la declara la plantilla", () => {
    const metricas = ["posQty", "posSales", "avgPrice", "avgSalesPerStore"];
    // Un producto con 4 filas: 10 piezas por 2,390 y 2 filas sin venta.
    const grupo = { suma: [10, 2390, 956, 240], n: [4, 4, 4, 4] };

    expect(valorMetricaAgregada(grupo, metricas, "posQty", { tipo: "suma" })).toBe(10);
    expect(valorMetricaAgregada(grupo, metricas, "posSales", { tipo: "suma" })).toBe(2390);
    // El precio sale del cociente de totales, no de sumar la columna (956) ni
    // de promediarla (239 aquí coincide, pero sólo porque el ejemplo es plano).
    expect(
      valorMetricaAgregada(grupo, metricas, "avgPrice", {
        tipo: "razon",
        numerador: "posSales",
        divisor: "posQty",
      })
    ).toBe(239);
    expect(
      valorMetricaAgregada(grupo, metricas, "avgSalesPerStore", { tipo: "promedio" })
    ).toBe(60);
    // Sin la columna que declara, la suma sería la respuesta equivocada.
    expect(valorMetricaAgregada(grupo, metricas, "posQty", { tipo: "suma" })).not.toBe(956);
  });

  it("una métrica sin con qué calcularse da null y no cero", () => {
    const metricas = ["posQty", "posSales", "avgPrice"];
    const razon = { tipo: "razon" as const, numerador: "posSales", divisor: "posQty" };

    // Un producto sin unidades vendidas no tiene precio promedio: "—" en la
    // tabla, que es distinto de "vale cero".
    expect(valorMetricaAgregada({ suma: [0, 0, 0], n: [3, 3, 3] }, metricas, "avgPrice", razon))
      .toBeNull();
    // Cero filas con el dato: tampoco hay promedio que sacar.
    expect(
      valorMetricaAgregada({ suma: [0, 0, 0], n: [0, 0, 0] }, metricas, "avgPrice", {
        tipo: "promedio",
      })
    ).toBeNull();
    // Una razón que apunta a una columna ausente no cae de vuelta en la suma.
    expect(
      valorMetricaAgregada({ suma: [1, 2], n: [1, 1] }, ["posSales", "avgPrice"], "avgPrice", razon)
    ).toBeNull();
    // Por omisión se suma, que es lo correcto para lo aditivo.
    expect(valorMetricaAgregada({ suma: [7, 9], n: [1, 1] }, ["posQty", "x"], "posQty")).toBe(7);
  });

  it("una columna que Walmart agregue sigue llegando a su filtro", async () => {
    const ds = await plantillaWalmart();
    // Numérica y sin declarar: la plantilla no la menciona, así que el filtro
    // sale de lo inferido en vez de quedar fuera de todos los selectores.
    const conExtra = [
      ...ds.columnas,
      {
        ...ds.columnas[ds.columnas.findIndex((c) => c.nombre === "POS Sales")],
        indice: 99,
        nombre: "Columna Nueva",
      },
    ];
    const resueltas = aplicarPlantilla(conExtra, WALMART_MENSUAL);
    expect(opcionesDeFiltro(resueltas, "metrica").map((c) => c.nombre)).toContain(
      "Columna Nueva"
    );
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

describe("comparativa año contra año", () => {
  /** Serie mensual: { "2025-01": 100, ... } → el mapa que come compararAnios. */
  const serie = (valores: Record<string, number>): Map<string, Acumulador> =>
    new Map(Object.entries(valores).map(([k, suma]) => [k, { suma, conteo: 1 }]));

  it("enfrenta el mismo mes de los dos años más recientes", () => {
    const c = compararAnios(
      serie({ "2025-01": 9861, "2025-02": 10455, "2026-01": 9757, "2026-02": 9520 }),
      "suma"
    )!;

    expect(c.anioActual).toBe(2026);
    expect(c.anioPrevio).toBe(2025);
    expect(c.puntos).toEqual([
      { mes: 1, actual: 9757, previo: 9861 },
      { mes: 2, actual: 9520, previo: 10455 },
    ]);
    expect(c.totalActual).toBe(19277);
    expect(c.totalPrevio).toBe(20316);
    expect(c.variacion).toBeCloseTo((19277 - 20316) / 20316, 10);
  });

  it("sin dos años no hay nada que comparar", () => {
    expect(compararAnios(serie({ "2026-01": 10, "2026-02": 20 }), "suma")).toBeNull();
    expect(compararAnios(new Map(), "suma")).toBeNull();
  });

  it("el mes que sólo tiene un año va en null y no en cero", () => {
    // El retailer reportó hasta marzo de 2026: marzo no es una venta de cero.
    const c = compararAnios(
      serie({ "2025-02": 500, "2025-03": 700, "2026-02": 600 }),
      "suma"
    )!;

    expect(c.puntos).toEqual([
      { mes: 2, actual: 600, previo: 500 },
      { mes: 3, actual: null, previo: 700 },
    ]);
  });

  it("los totales sólo cuentan los meses que tienen los dos años", () => {
    // 2025 completo contra un 2026 que va en enero: sumar los doce meses del
    // año pasado contra uno daría un -92% que no es real.
    const c = compararAnios(
      serie({
        "2025-01": 100,
        "2025-02": 100,
        "2025-03": 100,
        "2026-01": 120,
      }),
      "suma"
    )!;

    expect(c.mesesComparables).toBe(1);
    expect(c.totalActual).toBe(120);
    expect(c.totalPrevio).toBe(100);
    expect(c.variacion).toBeCloseTo(0.2, 10);
    // La gráfica sí dibuja los tres meses; sólo los totales se acotan.
    expect(c.puntos).toHaveLength(3);
  });

  it("con promedio, el total del año no es la suma de los promedios", () => {
    const mapa = new Map<string, Acumulador>([
      ["2025-01", { suma: 100, conteo: 10 }],
      ["2025-02", { suma: 300, conteo: 10 }],
      ["2026-01", { suma: 200, conteo: 10 }],
      ["2026-02", { suma: 200, conteo: 10 }],
    ]);
    const c = compararAnios(mapa, "promedio")!;

    // Por mes, el promedio de cada uno.
    expect(c.puntos).toEqual([
      { mes: 1, actual: 20, previo: 10 },
      { mes: 2, actual: 20, previo: 30 },
    ]);
    // Y el del año es 400/20, no 10 + 30.
    expect(c.totalPrevio).toBe(20);
    expect(c.totalActual).toBe(20);
    expect(c.variacion).toBe(0);
  });

  it("sin base positiva no hay porcentaje", () => {
    const c = compararAnios(serie({ "2025-01": 0, "2026-01": 500 }), "suma")!;
    expect(c.totalPrevio).toBe(0);
    expect(c.variacion).toBeNull();
  });

  // Con el filtro de periodo de la ficha, "el año pasado" deja de deducirse: si
  // alguien pidió T1 2026, la comparativa es contra el T1 de 2025 y no contra
  // los dos años que más aparezcan en el mapa.
  it("con ventana compara sólo esos meses contra el año inmediatamente anterior", () => {
    const c = compararAnios(
      serie({
        "2024-02": 1,
        "2025-01": 100,
        "2025-02": 200,
        "2025-03": 300,
        "2025-07": 999,
        "2026-01": 110,
        "2026-02": 190,
        "2026-03": 330,
        "2026-07": 888,
      }),
      "suma",
      { anio: 2026, meses: [1, 2, 3] }
    )!;

    expect(c.anioActual).toBe(2026);
    expect(c.anioPrevio).toBe(2025);
    // Julio está en los dos años y NO entra: queda fuera del trimestre pedido.
    expect(c.puntos).toEqual([
      { mes: 1, actual: 110, previo: 100 },
      { mes: 2, actual: 190, previo: 200 },
      { mes: 3, actual: 330, previo: 300 },
    ]);
    expect(c.totalActual).toBe(630);
    expect(c.totalPrevio).toBe(600);
    expect(c.mesesComparables).toBe(3);
  });

  it("con ventana y sin ningún mes con datos no hay comparativa", () => {
    // El primer trimestre del primer año reportado: no hay año anterior.
    expect(
      compararAnios(serie({ "2026-01": 100, "2026-02": 200 }), "suma", {
        anio: 2025,
        meses: [1, 2, 3],
      })
    ).toBeNull();
  });

  it("sin ventana sigue tomando los dos años presentes aunque no sean seguidos", () => {
    const c = compararAnios(serie({ "2024-01": 100, "2026-01": 120 }), "suma")!;
    expect([c.anioActual, c.anioPrevio]).toEqual([2026, 2024]);
  });
});
