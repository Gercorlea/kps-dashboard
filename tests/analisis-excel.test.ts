import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import {
  agrupar,
  calcularKpis,
  granularidadAuto,
  OTROS,
  serieTemporal,
  SIN_VALOR,
} from "@/lib/retail/analisis/agregar";
import { formatearEntero, formatearFecha } from "@/lib/retail/analisis/formato";
import {
  columnasDimension,
  detectarEncabezado,
  detectarFormatoNumerico,
  detectarOrdenFecha,
  elegirDimension,
  elegirFecha,
  elegirMetrica,
  letraColumna,
  parsearFechaTexto,
  parsearNumeroLocalizado,
  valorFecha,
  valorNumerico,
} from "@/lib/retail/analisis/inferir-tipos";
import {
  construirDataset,
  elegirHojaConDatos,
  ErrorExcel,
  leerLibro,
} from "@/lib/retail/analisis/parsear";
import type { Dataset, MetaColumna } from "@/lib/retail/analisis/tipos";

// El analizador infiere el esquema en vez de exigir las hojas fijas de la
// ingesta, así que lo que se prueba es la inferencia y la agregación: dónde
// está el encabezado, de qué tipo es cada columna, y que los totales no se
// desvíen por un separador de miles o una zona horaria.

type Fila = unknown[];

function libro(hojas: Record<string, Fila[]>): Buffer {
  const wb = XLSX.utils.book_new();
  for (const [name, aoa] of Object.entries(hojas)) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa, { cellDates: true }), name);
  }
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx", cellDates: true }) as Buffer;
}

/** Reproduce la carga real: Buffer → File → leerLibro → construirDataset. */
async function cargar(
  hojas: Record<string, Fila[]>,
  nombreHoja?: string,
  nombreArchivo = "prueba.xlsx"
): Promise<Dataset> {
  const buf = libro(hojas);
  const file = new File([new Uint8Array(buf)], nombreArchivo);
  const leidas = await leerLibro(file);
  return construirDataset(leidas, nombreHoja ?? elegirHojaConDatos(leidas));
}

function col(ds: Dataset, nombre: string): MetaColumna {
  const c = ds.columnas.find((x) => x.nombre === nombre);
  if (!c) throw new Error(`no existe la columna ${nombre}`);
  return c;
}

const CLIENTES = [
  "Acme SpA",
  "Beta Comercial",
  "Gamma Distribuidora",
  "Delta Retail",
  "Epsilon Mayorista",
  "Zeta Logística",
  "Eta Suministros",
  "Theta Import",
  "Iota Servicios",
  "Kappa Global",
];
const PRODUCTOS = ["Tornillo", "Tuerca", "Perno", "Arandela", "Clavo"];

/** Hoja de ventas realista: fechas reales, categorías, importes y folios. */
function hojaVentas(filas = 400): Fila[] {
  const aoa: Fila[] = [["Fecha", "Cliente", "Producto", "Cantidad", "Importe", "Folio"]];
  for (let i = 0; i < filas; i++) {
    aoa.push([
      new Date(2023, 0, 1 + Math.floor(i / 4)),
      CLIENTES[i % CLIENTES.length],
      PRODUCTOS[i % PRODUCTOS.length],
      1 + (i % 40),
      Math.round(((i * 7919) % 900000) + 1000) / 100,
      100000 + i,
    ]);
  }
  return aoa;
}

// ------------------------------------------------------------------ lectura

describe("leerLibro (frontera SheetJS)", () => {
  it("rechaza cualquier extensión que no sea .xlsx", async () => {
    const file = new File([new Uint8Array([1, 2, 3])], "reporte.xls");
    await expect(leerLibro(file)).rejects.toThrow(/Solo se aceptan archivos .xlsx/);
  });

  it("rechaza un archivo vacío", async () => {
    await expect(leerLibro(new File([], "vacio.xlsx"))).rejects.toThrow(/está vacío/);
  });

  it("da un ErrorExcel legible si el contenido no es un Excel", async () => {
    const file = new File([new TextEncoder().encode("esto no es un excel")], "falso.xlsx");
    await expect(leerLibro(file)).rejects.toBeInstanceOf(ErrorExcel);
    await expect(leerLibro(file)).rejects.toThrow(/No se pudo leer el archivo/);
  });

  it("lee todas las hojas y elige la primera con datos, no la portada", async () => {
    const buf = libro({
      Portada: [["Reporte generado automáticamente"]],
      Ventas: hojaVentas(10),
    });
    const hojas = await leerLibro(new File([new Uint8Array(buf)], "x.xlsx"));
    expect(hojas.map((h) => h.nombre)).toEqual(["Portada", "Ventas"]);
    expect(elegirHojaConDatos(hojas)).toBe("Ventas");
  });

  it("una hoja sin filas de datos da un error legible, no un crash", async () => {
    const buf = libro({ Portada: [["solo un título"]], Ventas: hojaVentas(5) });
    const hojas = await leerLibro(new File([new Uint8Array(buf)], "x.xlsx"));
    expect(() => construirDataset(hojas, "Portada")).toThrow(/no contiene filas de datos/);
  });
});

// ----------------------------------------------------------------- fechas

describe("fechas (el corrimiento por zona horaria)", () => {
  // SheetJS con cellDates y la opción UTC en su valor por omisión devuelve
  // fechas cuya interpretación LOCAL es la correcta. Todo el analizador lee
  // con getters locales; si esto se rompe, cada fecha se corre un día y las
  // ventas de fin de mes caen en el mes equivocado.
  it("una celda con formato de fecha se lee con el mismo día calendario", async () => {
    const ds = await cargar({
      Hoja1: [
        ["Fecha", "Importe"],
        [new Date(2023, 0, 1), 100],
        [new Date(2024, 11, 31), 200],
      ],
    });
    const fecha = col(ds, "Fecha");
    expect(fecha.tipo).toBe("fecha");
    expect(formatearFecha(valorFecha(ds.filas[0][0], fecha) as Date)).toBe("2023-01-01");
    expect(formatearFecha(valorFecha(ds.filas[1][0], fecha) as Date)).toBe("2024-12-31");
  });

  it("nunca convierte un número suelto en una fecha serial", async () => {
    const ds = await cargar({
      Hoja1: [
        ["Importe"],
        [45230.5], // en el rango de los seriales de Excel, pero es dinero
        [44927],
      ],
    });
    const importe = col(ds, "Importe");
    expect(importe.tipo).toBe("numero");
    expect(valorNumerico(ds.filas[0][0], importe)).toBe(45230.5);
    expect(valorFecha(ds.filas[1][0], importe)).toBeNull();
  });

  it("reconoce fechas escritas como texto y resuelve dd/mm por columna", async () => {
    const ds = await cargar({
      Hoja1: [
        ["Fecha", "Importe"],
        ["05/01/2024", 1],
        ["13/05/2024", 2], // el 13 delata que el primer componente es el día
        ["28/02/2024", 3],
      ],
    });
    const fecha = col(ds, "Fecha");
    expect(fecha.tipo).toBe("fecha");
    expect(fecha.ordenFecha).toBe("dia-mes");
    const d = valorFecha(ds.filas[0][0], fecha) as Date;
    expect(d.getMonth()).toBe(0); // enero, no mayo
    expect(d.getDate()).toBe(5);
  });

  it("detectarOrdenFecha usa el componente > 12 como testigo", () => {
    expect(detectarOrdenFecha(["05/01/2024", "13/05/2024"])).toBe("dia-mes");
    expect(detectarOrdenFecha(["01/13/2024", "05/28/2024"])).toBe("mes-dia");
    expect(detectarOrdenFecha(["05/01/2024"])).toBe("dia-mes"); // sin evidencia
  });

  it("rechaza fechas imposibles en vez de normalizarlas en silencio", () => {
    expect(parsearFechaTexto("31/02/2024", "dia-mes")).toBeNull();
    expect(parsearFechaTexto("32/01/2024", "dia-mes")).toBeNull();
  });

  it("una fecha ISO no se corre de día", () => {
    const d = parsearFechaTexto("2024-01-05", "dia-mes") as Date;
    expect(d.getFullYear()).toBe(2024);
    expect(d.getMonth()).toBe(0);
    expect(d.getDate()).toBe(5);
  });
});

// ---------------------------------------------------------------- números

describe("números escritos como texto", () => {
  it("resuelve el separador por columna, no por celda", () => {
    expect(detectarFormatoNumerico(["1.234", "5.678", "9.012"])).toBe("punto-miles");
    expect(detectarFormatoNumerico(["1.5", "2.75", "3.1"])).toBe("nativo");
    expect(detectarFormatoNumerico(["1,234.56"])).toBe("coma-miles");
  });

  it("con ambos separadores presentes manda el de más a la derecha", () => {
    expect(parsearNumeroLocalizado("1,234.56", "coma-miles")).toBe(1234.56);
    expect(parsearNumeroLocalizado("1.234,56", "punto-miles")).toBe(1234.56);
  });

  it("entiende moneda y paréntesis contables", () => {
    expect(parsearNumeroLocalizado("$ 1,000.00", "coma-miles")).toBe(1000);
    expect(parsearNumeroLocalizado("(1,234)", "coma-miles")).toBe(-1234);
    expect(parsearNumeroLocalizado("-1,500", "coma-miles")).toBe(-1500);
  });

  it("no inventa números donde no los hay", () => {
    expect(parsearNumeroLocalizado("Cliente 3", "coma-miles")).toBeNull();
    expect(parsearNumeroLocalizado("N/A", "coma-miles")).toBeNull();
    expect(parsearNumeroLocalizado("", "coma-miles")).toBeNull();
  });

  it("una columna de importes en texto suma igual que en Excel", async () => {
    const aoa: Fila[] = [["Cliente", "Importe"]];
    let esperado = 0;
    for (let i = 0; i < 120; i++) {
      const v = 1000 + i * 13 + (i % 100) / 100;
      esperado += v;
      aoa.push([CLIENTES[i % CLIENTES.length], `$ ${v.toLocaleString("en-US", {
        minimumFractionDigits: 2,
      })}`]);
    }
    const ds = await cargar({ Hoja1: aoa });
    const importe = col(ds, "Importe");
    expect(importe.tipo).toBe("numero");
    expect(importe.formatoNumerico).toBe("coma-miles");
    const total = ds.filas.reduce((s, f) => s + (valorNumerico(f[1], importe) ?? 0), 0);
    expect(total).toBeCloseTo(esperado, 2);
  });
});

// ------------------------------------------------------------- encabezado

describe("detección de encabezado", () => {
  it("salta el título y el periodo que los exports plantan arriba", async () => {
    const ds = await cargar({
      Hoja1: [
        ["REPORTE DE VENTAS — Sucursal Peñalolén"],
        ["Periodo: 01/01/2024 al 31/12/2024"],
        [],
        ["Fecha", "Cliente", "Vendedor", "Importe"],
        [new Date(2024, 0, 5), "Acme SpA", "José Muñoz", 1200],
        [new Date(2024, 0, 6), "Beta Comercial", "Ana Ríos", 900],
      ],
    });
    expect(ds.filaEncabezado).toBe(3);
    expect(ds.columnas.map((c) => c.nombre)).toEqual([
      "Fecha",
      "Cliente",
      "Vendedor",
      "Importe",
    ]);
    expect(ds.totalFilas).toBe(2);
  });

  it("un archivo enteramente de texto igual encuentra su encabezado", () => {
    const filas = [
      ["Cliente", "Estado"],
      ["Acme SpA", "Abierto"],
      ["Beta Comercial", "Cerrado"],
    ];
    expect(detectarEncabezado(filas)).toBe(0);
  });

  it("nombra las columnas sin título y desambigua las repetidas", async () => {
    const ds = await cargar({
      Hoja1: [
        ["Total", "", "Total"],
        [1, 2, 3],
        [4, 5, 6],
      ],
    });
    expect(ds.columnas.map((c) => c.nombre)).toEqual(["Total", "Columna B", "Total (2)"]);
  });

  it("letraColumna sigue la nomenclatura de Excel", () => {
    expect(letraColumna(0)).toBe("A");
    expect(letraColumna(25)).toBe("Z");
    expect(letraColumna(26)).toBe("AA");
  });
});

// ------------------------------------------------------ tipos y selección

describe("clasificación de columnas y valores por defecto", () => {
  it("distingue fecha, categoría y número", async () => {
    const ds = await cargar({ Hoja1: hojaVentas() });
    expect(col(ds, "Fecha").tipo).toBe("fecha");
    expect(col(ds, "Cliente").tipo).toBe("categoria");
    expect(col(ds, "Importe").tipo).toBe("numero");
    expect(col(ds, "Folio").tipo).toBe("numero");
  });

  it("marca los folios como identificador y no los propone como métrica", async () => {
    const ds = await cargar({ Hoja1: hojaVentas() });
    expect(col(ds, "Folio").esIdentificador).toBe(true);
    expect(col(ds, "Importe").esIdentificador).toBe(false);
    // Folio suma mucho más que Importe, pero es un ID: gana Importe.
    expect(ds.columnas[elegirMetrica(ds.columnas)].nombre).toBe("Importe");
  });

  it("elige como dimensión una columna con nombre de negocio", async () => {
    const ds = await cargar({ Hoja1: hojaVentas() });
    expect(ds.columnas[elegirDimension(ds.columnas)].nombre).toBe("Cliente");
    expect(ds.columnas[elegirFecha(ds.columnas)].nombre).toBe("Fecha");
  });

  it("no ofrece como dimensión una columna de 15k valores distintos", async () => {
    const ds = await cargar({ Hoja1: hojaVentas() });
    const nombres = columnasDimension(ds.columnas).map((c) => c.nombre);
    expect(nombres).toContain("Producto");
    expect(nombres).not.toContain("Folio");
  });

  it("una columna vacía se marca vacia y no aparece en los selectores", async () => {
    const ds = await cargar({
      Hoja1: [
        ["Cliente", "Notas"],
        ["Acme SpA", null],
        ["Beta Comercial", null],
      ],
    });
    expect(col(ds, "Notas").tipo).toBe("vacia");
    expect(columnasDimension(ds.columnas).map((c) => c.nombre)).not.toContain("Notas");
  });

  it("sin ninguna columna numérica cae a la métrica de conteo", async () => {
    const ds = await cargar({
      Hoja1: [
        ["Cliente", "Estado"],
        ["Acme SpA", "Abierto"],
        ["Beta Comercial", "Cerrado"],
      ],
    });
    expect(elegirMetrica(ds.columnas)).toBe(-1);
  });

  it("tolera un ND suelto sin degradar la columna a categoría", async () => {
    const aoa: Fila[] = [["Importe"]];
    for (let i = 0; i < 20; i++) aoa.push([i * 10]);
    aoa.push(["ND"]);
    const ds = await cargar({ Hoja1: aoa });
    expect(col(ds, "Importe").tipo).toBe("numero");
  });
});

// ------------------------------------------------------------ agregación

describe("agregación", () => {
  it("la suma por buckets coincide con la suma directa de la columna", async () => {
    const ds = await cargar({ Hoja1: hojaVentas() });
    const cliente = col(ds, "Cliente");
    const importe = col(ds, "Importe");
    const buckets = agrupar(ds.filas, cliente, importe, "suma", 99);
    const porBuckets = buckets.reduce((s, p) => s + p.suma, 0);
    const directa = ds.filas.reduce((s, f) => s + (valorNumerico(f[4], importe) ?? 0), 0);
    expect(porBuckets).toBeCloseTo(directa, 6);
  });

  it("pliega la cola en Otros y dice cuántos grupos se llevó", async () => {
    const ds = await cargar({ Hoja1: hojaVentas() });
    const top = agrupar(ds.filas, col(ds, "Cliente"), col(ds, "Importe"), "suma", 8);
    expect(top).toHaveLength(9);
    expect(top[8].clave).toBe(OTROS);
    expect(top[8].gruposPlegados).toBe(2); // 10 clientes - 8
  });

  it("Otros con promedio es ponderado, no promedio de promedios (§8.1)", async () => {
    // Grupos de tamaños muy distintos: el promedio ingenuo y el ponderado
    // difieren, así que el test distingue de verdad los dos cálculos.
    const aoa: Fila[] = [["Cliente", "Importe"]];
    aoa.push(["A", 100], ["A", 100], ["A", 100]);
    aoa.push(["B", 90], ["B", 90]);
    aoa.push(["C", 10]);
    aoa.push(["D", 8], ["D", 8], ["D", 8], ["D", 8]);
    const ds = await cargar({ Hoja1: aoa });
    const top = agrupar(ds.filas, col(ds, "Cliente"), col(ds, "Importe"), "promedio", 2);
    const otros = top[top.length - 1];
    expect(otros.clave).toBe(OTROS);
    // C y D plegados: (10 + 32) / (1 + 4) = 8.4, no (10 + 8) / 2 = 9.
    expect(otros.valor).toBeCloseTo(8.4, 6);
    expect(otros.valor).not.toBeCloseTo(9, 3);
  });

  it("una fila de subtotal con la dimensión vacía queda visible, no fusionada", async () => {
    const aoa = hojaVentas(20);
    aoa.push([null, null, null, 999, 123456.78, null]); // TOTAL GENERAL
    const ds = await cargar({ Hoja1: aoa });
    const buckets = agrupar(ds.filas, col(ds, "Cliente"), col(ds, "Importe"), "suma", 99);
    const sinValor = buckets.find((p) => p.clave === SIN_VALOR);
    expect(sinValor).toBeDefined();
    expect(sinValor?.conteo).toBe(1);
    expect(sinValor?.suma).toBeCloseTo(123456.78, 2);
  });

  it("la serie temporal rellena los huecos con cero y va en orden", async () => {
    const ds = await cargar({
      Hoja1: [
        ["Fecha", "Importe"],
        [new Date(2024, 0, 15), 10],
        [new Date(2024, 3, 10), 20],
      ],
    });
    const serie = serieTemporal(ds.filas, col(ds, "Fecha"), col(ds, "Importe"), "suma", "mes");
    expect(serie.map((p) => p.clave)).toEqual(["2024-01", "2024-02", "2024-03", "2024-04"]);
    expect(serie.map((p) => p.valor)).toEqual([10, 0, 0, 20]);
  });

  it("la granularidad automática sigue al rango de los datos", async () => {
    const corto = await cargar({
      Hoja1: [["Fecha"], [new Date(2024, 0, 1)], [new Date(2024, 0, 20)]],
    });
    expect(granularidadAuto(corto.filas, col(corto, "Fecha"))).toBe("dia");

    // Dos años de datos diarios se leen por mes (24 puntos), no por año (3).
    const dosAnios = await cargar({
      Hoja1: [["Fecha"], [new Date(2024, 4, 25)], [new Date(2026, 4, 29)]],
    });
    expect(granularidadAuto(dosAnios.filas, col(dosAnios, "Fecha"))).toBe("mes");

    const largo = await cargar({
      Hoja1: [["Fecha"], [new Date(2014, 0, 1)], [new Date(2024, 0, 1)]],
    });
    expect(granularidadAuto(largo.filas, col(largo, "Fecha"))).toBe("anio");
  });

  it("los KPIs cuadran con el dataset", async () => {
    const ds = await cargar({ Hoja1: hojaVentas(100) });
    const kpis = calcularKpis(
      ds.filas,
      col(ds, "Cliente"),
      col(ds, "Importe"),
      col(ds, "Fecha")
    );
    expect(kpis.totalFilas).toBe(100);
    expect(kpis.dimensionesDistintas).toBe(10);
    expect(formatearFecha(kpis.rangoFechas!.desde)).toBe("2023-01-01");
  });

  it("la métrica de conteo suma exactamente el total de filas", async () => {
    const ds = await cargar({ Hoja1: hojaVentas(100) });
    const buckets = agrupar(ds.filas, col(ds, "Cliente"), null, "conteo", 99);
    expect(buckets.reduce((s, p) => s + p.valor, 0)).toBe(100);
  });
});

// ------------------------------------------------------------- formato

describe("formato es-MX", () => {
  it("los miles llevan coma", () => {
    expect(formatearEntero(15234)).toBe("15,234");
  });

  it("las fechas se muestran en ISO como en SheetTable", () => {
    expect(formatearFecha(new Date(2024, 2, 5))).toBe("2024-03-05");
  });
});
