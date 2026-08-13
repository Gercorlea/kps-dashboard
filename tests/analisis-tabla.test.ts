import { describe, expect, it } from "vitest";
import {
  filtrarFilas,
  normalizarBusqueda,
  paginar,
  patronSinAcentos,
  totalPaginas,
} from "@/lib/retail/analisis/filtrar";
import { columnasBuscables } from "@/lib/retail/analisis/inferir-tipos";
import {
  columnasHistorico,
  filaCrudaDesdeHistorico,
  plantillaPorId,
  WALMART_MENSUAL,
} from "@/lib/retail/analisis/plantillas";
import { formatearCeldaNormalizada } from "@/lib/retail/analisis/formato";
import type { FilaCruda, MetaColumna } from "@/lib/retail/analisis/tipos";

function col(parcial: Partial<MetaColumna> & { indice: number }): MetaColumna {
  return {
    nombre: `C${parcial.indice}`,
    tipo: "categoria",
    noVacias: 10,
    cardinalidad: 5,
    esIdentificador: false,
    esConstante: false,
    magnitud: 0,
    formatoNumerico: "nativo",
    ordenFecha: null,
    ...parcial,
  };
}

// ------------------------------------------------------------- normalizar

describe("normalizarBusqueda", () => {
  it("baja a minúsculas y quita acentos", () => {
    expect(normalizarBusqueda("  ANALGÉSICO ")).toBe("analgesico");
  });

  it("pliega también la eñe, y eso está bien", () => {
    // NFD descompone la ñ en n + tilde, así que "ÑOÑO" y "nono" caen en la
    // misma cadena. No es una fuga: lo tecleado pasa por la MISMA función que
    // el dato, así que ninguna fila se vuelve inencontrable, y a cambio quien
    // escribe "nino" encuentra "NIÑO".
    expect(normalizarBusqueda("Ñoño")).toBe("nono");
    expect(normalizarBusqueda("NIÑO")).toBe(normalizarBusqueda("nino"));
  });

  it("es idempotente", () => {
    const una = normalizarBusqueda("Cápsulas 500MG");
    expect(normalizarBusqueda(una)).toBe(una);
  });
});

// --------------------------------------------------------------- filtrar

describe("filtrarFilas", () => {
  const columnas = [col({ indice: 0 }), col({ indice: 2 })];
  const filas: FilaCruda[] = [
    ["Jabón Zote", 100, "MARCA A"],
    ["Shampoo", 200, "Marca B"],
    ["jabon líquido", 300, "MARCA A"],
  ];

  it("busca por subcadena sin distinguir mayúsculas ni acentos", () => {
    expect(filtrarFilas(filas, columnas, "jabon")).toHaveLength(2);
    expect(filtrarFilas(filas, columnas, "JABÓN")).toHaveLength(2);
  });

  it("busca en todas las columnas indicadas, no sólo en la primera", () => {
    expect(filtrarFilas(filas, columnas, "marca b")).toEqual([filas[1]]);
  });

  it("ignora las columnas fuera de la lista", () => {
    // La columna 1 (numérica) no está entre las buscables: "200" no debe calzar.
    expect(filtrarFilas(filas, columnas, "200")).toEqual([]);
  });

  it("devuelve la MISMA referencia con búsqueda vacía", () => {
    // Es lo que evita que los useMemo de la tabla recalculen en cada render
    // mientras el buscador está en blanco.
    expect(filtrarFilas(filas, columnas, "   ")).toBe(filas);
  });

  it("no revienta con celdas nulas", () => {
    const conNulos: FilaCruda[] = [[null, 1, null], ["Jabón", 2, null]];
    expect(filtrarFilas(conNulos, columnas, "jabon")).toHaveLength(1);
  });
});

// ------------------------------------------------------ patrón para Mongo

describe("patronSinAcentos", () => {
  const calza = (patron: string, texto: string) =>
    new RegExp(patron, "i").test(texto);

  it("encuentra el texto acentuado escribiendo sin acentos, y al revés", () => {
    expect(calza(patronSinAcentos("analgesico"), "ANALGÉSICO 500MG")).toBe(true);
    expect(calza(patronSinAcentos("ANALGÉSICO"), "analgesico 500mg")).toBe(true);
  });

  it("da el mismo veredicto que filtrarFilas", () => {
    // Las dos mitades del buscador tienen que coincidir: si divergen, la misma
    // palabra encuentra filas en el archivo y no en el histórico.
    const columnas = [col({ indice: 0 })];
    for (const texto of ["Café", "cafe", "NIÑO", "nino", "Jabón Zote"]) {
      for (const dato of ["CAFÉ SOLUBLE", "cafe soluble", "NIÑO", "JABON ZOTE"]) {
        expect(calza(patronSinAcentos(texto), dato)).toBe(
          filtrarFilas([[dato]], columnas, texto).length === 1
        );
      }
    }
  });

  it("escapa los metacaracteres en vez de interpretarlos", () => {
    expect(calza(patronSinAcentos("a.c"), "abc")).toBe(false);
    expect(calza(patronSinAcentos("a.c"), "a.c")).toBe(true);
    expect(() => new RegExp(patronSinAcentos("(("))).not.toThrow();
  });
});

// --------------------------------------------------------------- paginar

describe("paginar", () => {
  const filas = Array.from({ length: 250 }, (_, i) => i);

  it("corta páginas completas y una última parcial", () => {
    expect(paginar(filas, 1, 100)).toHaveLength(100);
    expect(paginar(filas, 1, 100)[0]).toBe(0);
    expect(paginar(filas, 2, 100)[0]).toBe(100);
    expect(paginar(filas, 3, 100)).toHaveLength(50);
  });

  it("acota la página al rango válido en vez de devolver vacío", () => {
    // Al teclear en el buscador el total se encoge y la página actual puede
    // quedar fuera: mostrar una tabla vacía habiendo resultados sería un error.
    expect(paginar(filas, 99, 100)).toEqual(paginar(filas, 3, 100));
    expect(paginar(filas, 0, 100)).toEqual(paginar(filas, 1, 100));
  });

  it("totalPaginas nunca baja de una", () => {
    expect(totalPaginas(0, 100)).toBe(1);
    expect(totalPaginas(100, 100)).toBe(1);
    expect(totalPaginas(101, 100)).toBe(2);
    expect(totalPaginas(15_344, 100)).toBe(154);
  });
});

// ----------------------------------------------------------- buscables

describe("columnasBuscables", () => {
  it("toma texto y códigos; deja fuera métricas, fechas y constantes", () => {
    const columnas = [
      col({ indice: 0, nombre: "Prime Item Desc" }),
      col({ indice: 1, nombre: "POS Sales", tipo: "numero" }),
      col({ indice: 2, nombre: "Daily", tipo: "fecha" }),
      col({ indice: 3, nombre: "Item Nbr", tipo: "numero", esIdentificador: true }),
      col({ indice: 4, nombre: "Vendor Name", esConstante: true }),
      col({ indice: 5, nombre: "Item Flags", tipo: "vacia" }),
    ];
    expect(columnasBuscables(columnas).map((c) => c.nombre)).toEqual([
      "Prime Item Desc",
      "Item Nbr",
    ]);
  });
});

// ------------------------------------------------------------- histórico

describe("columnasHistorico", () => {
  const columnas = columnasHistorico(WALMART_MENSUAL);

  it("deja fuera las columnas ignoradas de la plantilla", () => {
    const ignoradas = WALMART_MENSUAL.columnas.filter((c) => c.rol === "ignorada");
    expect(ignoradas.length).toBeGreaterThan(0);
    expect(columnas).toHaveLength(WALMART_MENSUAL.columnas.length - ignoradas.length);
    expect(columnas.map((c) => c.nombre)).not.toContain("Vendor Name");
  });

  it("numera los índices por posición, para poder indexar la fila", () => {
    expect(columnas.map((c) => c.indice)).toEqual(columnas.map((_, i) => i));
  });

  it("marca como identificadores los códigos y no las métricas", () => {
    const porNombre = new Map(columnas.map((c) => [c.nombre, c]));
    expect(porNombre.get("Item Nbr")?.esIdentificador).toBe(true);
    expect(porNombre.get("UPC")?.esIdentificador).toBe(true);
    expect(porNombre.get("POS Sales")?.esIdentificador).toBe(false);
    expect(porNombre.get("POS Sales")?.tipo).toBe("numero");
    expect(porNombre.get("Daily")?.tipo).toBe("fecha");
  });

  it("expone las mismas columnas buscables que la tabla del archivo", () => {
    const nombres = columnasBuscables(columnas).map((c) => c.nombre);
    expect(nombres).toContain("Prime Item Desc");
    expect(nombres).toContain("UPC");
    expect(nombres).not.toContain("POS Sales");
  });
});

describe("filaCrudaDesdeHistorico", () => {
  const columnas = columnasHistorico(WALMART_MENSUAL);
  // Tal como lo devuelve el endpoint: fecha ya en ISO, UPC como texto.
  const doc = {
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

  it("ordena los valores como las columnas", () => {
    const fila = filaCrudaDesdeHistorico(doc, columnas);
    for (const c of columnas) {
      expect(fila[c.indice]).toBe(doc[c.campo as keyof typeof doc] ?? null);
    }
  });

  it("rellena con null los campos ausentes", () => {
    const fila = filaCrudaDesdeHistorico({ itemNbr: 1 }, columnas);
    const iMarca = columnas.find((c) => c.campo === "brand")!.indice;
    expect(fila[iMarca]).toBeNull();
  });

  it("se formatea igual que una fila del Excel", () => {
    const fila = filaCrudaDesdeHistorico(doc, columnas);
    const buscar = (campo: string) => {
      const c = columnas.find((x) => x.campo === campo)!;
      return formatearCeldaNormalizada(fila[c.indice], c);
    };
    // La fecha llega en ISO y se queda en ISO, sin corrimiento de zona.
    expect(buscar("date")).toBe("2024-07-06");
    // El UPC conserva el cero a la izquierda y el folio no lleva separadores.
    expect(buscar("upc")).toBe("0750229353070");
    expect(buscar("itemNbr")).toBe("101252325");
    // Las métricas sí llevan formato es-MX.
    expect(buscar("posSales")).toBe("1,234.50");
  });
});

describe("plantillaPorId", () => {
  it("resuelve el id que guarda el histórico", () => {
    expect(plantillaPorId("walmart-mensual")).toBe(WALMART_MENSUAL);
  });

  it("devuelve null para una plantilla que ya no existe", () => {
    expect(plantillaPorId("inexistente")).toBeNull();
  });
});
