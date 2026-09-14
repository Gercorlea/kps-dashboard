import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { elegirHojas, leerCatalogo } from "@/lib/catalogo/leer-excel";
import { ErrorExcel } from "@/lib/retail/analisis/parsear";

// El lector se prueba contra libros SINTÉTICOS y no contra un archivo real
// porque el del catálogo todavía no existe: lo mantiene a mano el encargado de
// KPS. Cuando lo entregue hay que comprometerlo —como está comprometido el de
// Walmart en src/lib/retail/analisis/— y añadir un describe que lo lea, que es
// lo único que atrapa las trampas que no se le ocurren a nadie.

/** Encabezados de la hoja 1 tal como los describe el archivo. */
const H_PRODUCTO = [
  "Item", "Descripcion", "ECOM", "trello", "unidad", "Estatus", "linea", "UPC",
  "clave SAT", "Fracción Arancelaria", "SUV", "Gramaje", "Meses de caducidad",
  "Fecha lanzamiento", "Proveedor 1", "Proveedor 2", "Proveedor 3",
];

const H_MAPEO = ["sku", "canal", "codigo cliente", "descripcion"];

/** Una fila de producto completa; se sobrescriben celdas por índice. */
function filaProducto(over: Record<number, unknown> = {}): unknown[] {
  const base: unknown[] = [
    "PTAL001", "Multiblue magnesio 60 Cap / 39 g", "si", "ok", "Pz", "Activo",
    "bloom", "7502293531399", "12345678", "87654321", "DER", 39, 24,
    "1-Sep-24", "ClienteChido", "", "",
  ];
  for (const [i, v] of Object.entries(over)) base[Number(i)] = v;
  return base;
}

/** Construye un .xlsx en memoria y lo entrega como File, igual que el navegador. */
function libro(hojas: { nombre: string; filas: unknown[][] }[]): File {
  const wb = XLSX.utils.book_new();
  for (const h of hojas) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(h.filas), h.nombre);
  }
  const bytes = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
  return new File([new Uint8Array(bytes)], "catalogo.xlsx");
}

/** El caso normal: las dos hojas, encabezado en la fila 1. */
function libroNormal(
  productos: unknown[][] = [filaProducto()],
  mapeos: unknown[][] = [["PTAL001", "walmart", "100436765", "Multiblue magnesio"]]
): File {
  return libro([
    { nombre: "Catalogo", filas: [H_PRODUCTO, ...productos] },
    { nombre: "Mapeo", filas: [H_MAPEO, ...mapeos] },
  ]);
}

describe("leerCatalogo — el caso normal", () => {
  it("lee las dos hojas y normaliza cada tipo de celda", async () => {
    const r = await leerCatalogo(libroNormal());

    expect(r.productSheet).toBe("Catalogo");
    expect(r.mappingSheet).toBe("Mapeo");
    expect(r.productos).toHaveLength(1);
    expect(r.mapeos).toHaveLength(1);

    const p = r.productos[0];
    expect(p.item).toBe("PTAL001");
    expect(p.description).toBe("Multiblue magnesio 60 Cap / 39 g");
    expect(p.status).toBe("Activo");
    expect(p.line).toBe("bloom");
    expect(p.salesUnit).toBe("Pz");
    expect(p.grammage).toBe(39);
    expect(p.shelfLifeMonths).toBe(24);
    expect(p.suv).toBe("DER");
    // Proveedor 1..3 colapsan sin vacíos.
    expect(p.suppliers).toEqual(["ClienteChido"]);
    // rowNumber es la fila REAL de Excel (encabezado en 1, dato en 2).
    expect(p.rowNumber).toBe(2);

    const m = r.mapeos[0];
    expect(m.sku).toBe("PTAL001");
    expect(m.channel).toBe("walmart");
    expect(m.channelName).toBe("Walmart");
    expect(m.knownRetailer).toBe(true);
    expect(m.customerCode).toBe("100436765");
    expect(m.customerCodeNum).toBe(100436765);
  });

  it("guarda los códigos como texto, conservando el cero a la izquierda", async () => {
    const r = await leerCatalogo(libroNormal([filaProducto({ 7: "0750229353070" })]));
    expect(r.productos[0].upc).toBe("0750229353070");
    expect(typeof r.productos[0].upc).toBe("string");
  });

  it("conserva ECOM y Trello como texto libre, sin normalizar el vocabulario", async () => {
    const r = await leerCatalogo(
      libroNormal([filaProducto({ 2: "Sí" }), filaProducto({ 0: "PTAL002", 2: "NO", 3: "NA" })])
    );
    expect(r.productos.map((p) => p.ecom)).toEqual(["Sí", "NO"]);
    expect(r.productos.map((p) => p.trello)).toEqual(["ok", "NA"]);
  });
});

describe("leerCatalogo — fechas de lanzamiento", () => {
  it('interpreta "1-Sep-24" y una celda Date real de la misma forma', async () => {
    const texto = await leerCatalogo(libroNormal([filaProducto({ 13: "1-Sep-24" })]));
    const real = await leerCatalogo(
      libroNormal([filaProducto({ 13: new Date(Date.UTC(2024, 8, 1)) })])
    );
    expect(texto.productos[0].launchDate).toBe("2024-09-01");
    expect(real.productos[0].launchDate).toBe("2024-09-01");
  });

  it("acepta mes en español completo y año de cuatro dígitos", async () => {
    const r = await leerCatalogo(libroNormal([filaProducto({ 13: "15-enero-2025" })]));
    expect(r.productos[0].launchDate).toBe("2025-01-15");
  });

  it("conserva el texto original cuando la fecha no se puede interpretar", async () => {
    const r = await leerCatalogo(libroNormal([filaProducto({ 13: "cuando salga" })]));
    expect(r.productos[0].launchDate).toBeNull();
    // Sin esto el dato desaparece de la ficha y nadie sabe que el archivo lo traía.
    expect(r.productos[0].launchDateText).toBe("cuando salga");
  });

  it("rechaza una fecha imposible en vez de rodarla al mes siguiente", async () => {
    const r = await leerCatalogo(libroNormal([filaProducto({ 13: "31-Feb-24" })]));
    expect(r.productos[0].launchDate).toBeNull();
    expect(r.productos[0].launchDateText).toBe("31-Feb-24");
  });
});

describe("leerCatalogo — ausente no es cero", () => {
  it('deja en null el Gramaje vacío y el "ND", pero conserva el cero', async () => {
    const r = await leerCatalogo(
      libroNormal([
        filaProducto({ 0: "PTAL001", 11: "" }),
        filaProducto({ 0: "PTAL002", 11: "ND" }),
        filaProducto({ 0: "PTAL003", 11: 0 }),
      ])
    );
    expect(r.productos.map((p) => p.grammage)).toEqual([null, null, 0]);
  });
});

describe("leerCatalogo — columnas obligatorias frente a opcionales", () => {
  it("rechaza el archivo si falta una columna requerida, y la nombra", async () => {
    const sinLinea = H_PRODUCTO.filter((h) => h !== "linea");
    const filas = [filaProducto()];
    filas[0].splice(6, 1);
    const file = libro([{ nombre: "Catalogo", filas: [sinLinea, ...filas] }]);

    await expect(leerCatalogo(file)).rejects.toThrow(ErrorExcel);
    await expect(leerCatalogo(file)).rejects.toThrow(/Línea/);
  });

  it("descarta la fila a la que le falta un campo obligatorio y dice cuál", async () => {
    const r = await leerCatalogo(
      libroNormal([filaProducto(), filaProducto({ 0: "PTAL002", 5: "" })])
    );
    expect(r.productos).toHaveLength(1);
    expect(r.descartadas.productos).toBe(1);
    const inc = r.incidencias.find((i) => i.row === 3);
    expect(inc?.field).toBe("status");
    expect(inc?.message).toMatch(/Estatus/);
  });

  it("conserva la fila a la que sólo le faltan campos opcionales", async () => {
    const r = await leerCatalogo(
      libroNormal([filaProducto({ 2: "", 7: "", 11: "", 13: "", 14: "" })])
    );
    expect(r.productos).toHaveLength(1);
    expect(r.descartadas.productos).toBe(0);
    const p = r.productos[0];
    expect(p.ecom).toBe("");
    expect(p.upc).toBe("");
    expect(p.grammage).toBeNull();
    expect(p.launchDate).toBeNull();
    expect(p.suppliers).toEqual([]);
  });

  it("carga el archivo al que le faltan columnas opcionales, con incidencia", async () => {
    // Sólo las cuatro requeridas.
    const file = libro([
      {
        nombre: "Catalogo",
        filas: [
          ["Item", "Descripcion", "Estatus", "linea"],
          ["PTAL001", "Multiblue", "Activo", "bloom"],
        ],
      },
    ]);
    const r = await leerCatalogo(file);
    expect(r.productos).toHaveLength(1);
    expect(r.productos[0].upc).toBe("");
    // Las que pinta la tabla avisan; el resto es informativo.
    const avisos = r.incidencias.filter((i) => i.severity === "aviso");
    expect(avisos.map((i) => i.field)).toEqual(
      expect.arrayContaining(["salesUnit", "upc", "launchDate"])
    );
    expect(r.incidencias.some((i) => i.field === "grammage" && i.severity === "info")).toBe(true);
  });

  it("rechaza la hoja de catálogo sin ninguna fila utilizable", async () => {
    const file = libro([{ nombre: "Catalogo", filas: [H_PRODUCTO] }]);
    await expect(leerCatalogo(file)).rejects.toThrow(/ninguna fila de producto/);
  });
});

describe("leerCatalogo — duplicados", () => {
  it("conserva la última aparición de un Item repetido y lo reporta", async () => {
    const r = await leerCatalogo(
      libroNormal([
        filaProducto({ 1: "Versión vieja" }),
        filaProducto({ 1: "Versión nueva" }),
      ])
    );
    expect(r.productos).toHaveLength(1);
    expect(r.productos[0].description).toBe("Versión nueva");
    expect(r.incidencias.some((i) => /filas 2 y 3/.test(i.message))).toBe(true);
  });

  it("colapsa un (sku, canal) repetido pero conserva el mismo sku en otro canal", async () => {
    const r = await leerCatalogo(
      libroNormal(undefined, [
        ["PTAL001", "walmart", "111", "a"],
        ["PTAL001", "walmart", "222", "b"],
        ["PTAL001", "san pablo", "333", "c"],
      ])
    );
    expect(r.mapeos).toHaveLength(2);
    expect(r.mapeos.find((m) => m.channel === "walmart")?.customerCode).toBe("222");
    expect(r.mapeos.find((m) => m.channel === "san-pablo")?.customerCode).toBe("333");
  });
});

describe("leerCatalogo — la hoja de mapeo", () => {
  it("acepta un canal desconocido, marcándolo, en vez de perder la fila", async () => {
    const r = await leerCatalogo(
      libroNormal(undefined, [["PTAL001", "Súper Aki", "555", "x"]])
    );
    expect(r.mapeos[0].channel).toBe("super-aki");
    expect(r.mapeos[0].channelName).toBe("Súper Aki");
    expect(r.mapeos[0].knownRetailer).toBe(false);
  });

  it("descarta la fila de mapeo sin sku o sin canal", async () => {
    const r = await leerCatalogo(
      libroNormal(undefined, [
        ["PTAL001", "walmart", "100", "ok"],
        ["", "walmart", "200", "sin sku"],
        ["PTAL002", "", "300", "sin canal"],
      ])
    );
    expect(r.mapeos).toHaveLength(1);
    expect(r.descartadas.mapeos).toBe(2);
  });

  it("conserva la fila sin código de cliente: la cadena aún no lo dio de alta", async () => {
    const r = await leerCatalogo(libroNormal(undefined, [["PTAL001", "heb", "", "x"]]));
    expect(r.mapeos).toHaveLength(1);
    expect(r.mapeos[0].customerCode).toBe("");
    expect(r.mapeos[0].customerCodeNum).toBeNull();
  });

  it("no inventa un número cuando el código no es entero, y lo avisa", async () => {
    const r = await leerCatalogo(libroNormal(undefined, [["PTAL001", "walmart", "A-1004", "x"]]));
    expect(r.mapeos[0].customerCode).toBe("A-1004");
    expect(r.mapeos[0].customerCodeNum).toBeNull();
    expect(r.incidencias.some((i) => i.field === "customerCode")).toBe(true);
  });

  it("acepta un sku que no está en el catálogo: el mapeo lo mantiene otra persona", async () => {
    const r = await leerCatalogo(libroNormal(undefined, [["PTAL999", "walmart", "1", "x"]]));
    expect(r.mapeos).toHaveLength(1);
    expect(r.mapeos[0].sku).toBe("PTAL999");
  });

  it("cruza el sku con el Item aunque difieran en caja y espacios", async () => {
    const r = await leerCatalogo(
      libroNormal([filaProducto({ 0: "PTAL001" })], [[" ptal001 ", "walmart", "1", "x"]])
    );
    expect(r.mapeos[0].sku).toBe(r.productos[0].item);
  });

  it("carga el catálogo sin mapeo si el archivo trae una sola hoja", async () => {
    const file = libro([{ nombre: "Catalogo", filas: [H_PRODUCTO, filaProducto()] }]);
    const r = await leerCatalogo(file);
    expect(r.mappingSheet).toBeNull();
    expect(r.mapeos).toEqual([]);
    expect(r.incidencias.some((i) => i.severity === "aviso")).toBe(true);
  });
});

describe("leerCatalogo — localizar las hojas y el encabezado", () => {
  it("encuentra el encabezado aunque haya filas de preámbulo", async () => {
    const file = libro([
      {
        nombre: "Catalogo",
        filas: [["Catálogo de productos KPS"], [], H_PRODUCTO, filaProducto()],
      },
    ]);
    const r = await leerCatalogo(file);
    expect(r.productos).toHaveLength(1);
    // La fila real de Excel, para poder auditar contra el archivo.
    expect(r.productos[0].rowNumber).toBe(4);
  });

  it("usa la posición cuando los nombres de las hojas no dicen nada", async () => {
    const file = libro([
      { nombre: "Hoja1", filas: [H_PRODUCTO, filaProducto()] },
      { nombre: "Hoja2", filas: [H_MAPEO, ["PTAL001", "walmart", "1", "x"]] },
    ]);
    const r = await leerCatalogo(file);
    expect(r.productSheet).toBe("Hoja1");
    expect(r.mappingSheet).toBe("Hoja2");
  });

  it("intercambia las hojas si vienen al revés, guiándose por los encabezados", async () => {
    const file = libro([
      { nombre: "Hoja1", filas: [H_MAPEO, ["PTAL001", "walmart", "1", "x"]] },
      { nombre: "Hoja2", filas: [H_PRODUCTO, filaProducto()] },
    ]);
    const r = await leerCatalogo(file);
    expect(r.productSheet).toBe("Hoja2");
    expect(r.mappingSheet).toBe("Hoja1");
    expect(r.productos).toHaveLength(1);
    expect(r.mapeos).toHaveLength(1);
  });

  it("elige las hojas por nombre cuando el nombre sí dice algo", async () => {
    const hojas = [
      { nombre: "Mapeo de productos", filas: [H_MAPEO, ["PTAL001", "walmart", "1", "x"]] },
      { nombre: "Catalogo", filas: [H_PRODUCTO, filaProducto()] },
    ];
    const { productos, mapeo } = elegirHojas(
      hojas.map((h) => ({ nombre: h.nombre, datos: h.filas as never }))
    );
    expect(productos.nombre).toBe("Catalogo");
    expect(mapeo?.nombre).toBe("Mapeo de productos");
  });

  it("rechaza la hoja de catálogo sin encabezado reconocible", async () => {
    const file = libro([
      { nombre: "Catalogo", filas: [["a", "b", "c"], [1, 2, 3]] },
    ]);
    await expect(leerCatalogo(file)).rejects.toThrow(/No se encontró el encabezado/);
  });
});

describe("leerCatalogo — encabezados escritos de otra forma", () => {
  it("tolera acentos, caja y espacios sobrantes", async () => {
    const file = libro([
      {
        nombre: "Catalogo",
        filas: [
          [
            " Item ", "Descripción", "E-Commerce", "Trello", "Unidad de venta",
            "Status", "Línea de producto", "Código de barras", "Clave SAT",
            "Fracción Arancelaria ", "suv", "Gramaje", "Vida util",
            "Fecha de lanzamiento", "Proveedor1", "Proveedor2", "Proveedor3",
          ],
          filaProducto(),
        ],
      },
    ]);
    const r = await leerCatalogo(file);
    const p = r.productos[0];
    expect(p.item).toBe("PTAL001");
    expect(p.status).toBe("Activo");
    expect(p.line).toBe("bloom");
    expect(p.upc).toBe("7502293531399");
    expect(p.satCode).toBe("12345678");
    expect(p.tariffCode).toBe("87654321");
    expect(p.launchDate).toBe("2024-09-01");
    // Ninguna columna se dio por faltante: las incidencias de columna llevan
    // `field`, y aquí la única que hay es la de "el archivo trae una sola hoja".
    expect(r.incidencias.filter((i) => i.field !== undefined)).toHaveLength(0);
  });
});
