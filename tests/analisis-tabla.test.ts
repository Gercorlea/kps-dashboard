import { describe, expect, it } from "vitest";
import {
  filtrarFilas,
  normalizarBusqueda,
  paginar,
  patronSinAcentos,
  totalPaginas,
} from "@/lib/retail/analisis/filtrar";
import {
  columnasBuscables,
  columnasDimension,
  columnasMetrica,
  valorFecha,
  valorNumerico,
} from "@/lib/retail/analisis/inferir-tipos";
import {
  columnasHistorico,
  datasetDesdeHistorico,
  opcionesDeFiltro,
  plantillaPorId,
  WALMART_MENSUAL,
} from "@/lib/retail/analisis/plantillas";
import { formatearCeldaNormalizada } from "@/lib/retail/analisis/formato";
import { anchosUniformes, huecosPorColumna } from "@/components/retail/AnalisisTable";
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

// ------------------------------------------------------------- anchos

describe("huecosPorColumna", () => {
  // false = alineada a la izquierda (texto), true = a la derecha (números).
  it("cada hueco lo paga UNA columna: la que tiene el espacio libre de ese lado", () => {
    // El catálogo: cuatro de texto y tres de números.
    const huecos = huecosPorColumna([false, false, false, false, true, true, true]);
    // "Unidades" (la primera de números) no paga nada: el hueco que la separa
    // de "Marca" ya lo paga "Marca" por su derecha. Sin esto ese hueco salía
    // del doble que los demás, que es el bug que esto arregla.
    expect(huecos).toEqual([1, 1, 1, 1, 0, 1, 1]);
  });

  it("reparte tantos huecos como separaciones hay en la fila", () => {
    for (const alineaciones of [
      [false, false, false, false, true, true, true],
      [true, true, true],
      [false, false, false],
      [false, true, false, true],
    ]) {
      const suma = huecosPorColumna(alineaciones).reduce((a, b) => a + b, 0);
      expect(suma, alineaciones.join(",")).toBe(alineaciones.length - 1);
    }
  });

  it("ni la primera paga por su izquierda ni la última por su derecha", () => {
    // Todo texto: la última no paga, así que la tabla no termina en un hueco.
    expect(huecosPorColumna([false, false, false])).toEqual([1, 1, 0]);
    // Todo números: la primera no paga, así que no empieza con uno.
    expect(huecosPorColumna([true, true, true])).toEqual([0, 1, 1]);
  });

  it("una sola columna no tiene huecos", () => {
    expect(huecosPorColumna([false])).toEqual([0]);
    expect(huecosPorColumna([])).toEqual([]);
  });
});

describe("anchosUniformes", () => {
  // El catálogo de productos tal como queda: columnas de identidad primero y
  // las de números después, con contenidos de largos muy distintos.
  const columnas = [
    col({ indice: 0, nombre: "Nombre del producto" }),
    col({ indice: 1, nombre: "Código del producto", tipo: "numero", esIdentificador: true }),
    col({ indice: 2, nombre: "UPC", esIdentificador: true }),
    col({ indice: 3, nombre: "Marca" }),
    col({ indice: 4, nombre: "Unidades", tipo: "numero" }),
    col({ indice: 5, nombre: "Ventas netas", tipo: "numero" }),
  ];
  const filas: FilaCruda[] = [
    ["TALLARIN CHINO 200G", 552704178, "0007501234567", "KPS", 1234, 987654],
  ];

  const pixeles = (ancho: string) => Number(ancho.match(/^(?:calc\()?(\d+)px/)![1]);

  it("el sobrante se reparte en partes iguales entre los huecos", () => {
    const { anchos, minimo } = anchosUniformes(columnas, filas);
    const sobrante = `(100% - ${minimo}px) / ${columnas.length - 1}`;
    // Una parte para cada columna que paga un hueco…
    expect(anchos.filter((a) => a.endsWith(`+ ${sobrante})`))).toHaveLength(5);
    // …y ninguna para "Unidades", que no paga ninguno.
    expect(anchos[4]).toMatch(/^\d+px$/);
  });

  it("el suelo es la suma de los contenidos: ahí el sobrante es cero", () => {
    const { anchos, minimo } = anchosUniformes(columnas, filas);
    expect(anchos.map(pixeles).reduce((a, b) => a + b, 0)).toBe(minimo);
  });

  it("una columna con más contenido se lleva más pixeles propios", () => {
    const { anchos } = anchosUniformes(columnas, filas);
    // El nombre del producto contra la marca, que son tres letras.
    expect(pixeles(anchos[0])).toBeGreaterThan(pixeles(anchos[3]));
  });

  it("sin columnas no divide entre cero", () => {
    expect(anchosUniformes([], [])).toEqual({ anchos: [], minimo: 0 });
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

  it("dice qué métricas NO se pueden totalizar, que son las ya promediadas", () => {
    // De aquí sale el guión largo de "Totales del reporte" (ReporteDetalle):
    // sumar una columna que ya viene promediada fila a fila da una cifra falsa.
    // Si mañana se declara otra métrica con un agregado que no es la suma,
    // esta lista cambia y hay que decidir si su total significa algo.
    const noAditivas = columnas
      .filter((c) => c.rol === "metrica" && c.agregado.tipo !== "suma")
      .map((c) => c.nombre);
    expect(noAditivas).toEqual(["Precio promedio", "Venta promedio por tienda"]);
  });

  it("marca como identificadores los códigos y no las métricas", () => {
    // Por campo: el nombre visible lo fija la etiqueta de la plantilla.
    const porCampo = new Map(columnas.map((c) => [c.campo, c]));
    expect(porCampo.get("itemNbr")?.esIdentificador).toBe(true);
    expect(porCampo.get("upc")?.esIdentificador).toBe(true);
    expect(porCampo.get("posSales")?.esIdentificador).toBe(false);
    expect(porCampo.get("posSales")?.tipo).toBe("numero");
    expect(porCampo.get("date")?.tipo).toBe("fecha");
  });

  it("expone las mismas columnas buscables que la tabla del archivo", () => {
    const nombres = columnasBuscables(columnas).map((c) => c.nombre);
    expect(nombres).toContain("Nombre del producto");
    expect(nombres).toContain("UPC");
    expect(nombres).not.toContain("Ventas netas");
  });

  it("lleva las etiquetas de la plantilla, no los encabezados en inglés", () => {
    const porCampo = new Map(columnas.map((c) => [c.campo, c]));
    expect(porCampo.get("brand")?.nombre).toBe("Marca");
    expect(porCampo.get("posQty")?.nombre).toBe("Unidades");
    expect(porCampo.get("posSales")?.nombre).toBe("Ventas netas");
  });

  it("ofrece en cada filtro sólo lo que declara la plantilla", () => {
    expect(opcionesDeFiltro(columnas, "dimension").map((c) => c.nombre)).toEqual([
      "Marca",
      "Código del producto",
      "Nombre del producto",
      "UPC",
    ]);
    expect(opcionesDeFiltro(columnas, "metrica").map((c) => c.nombre)).toEqual([
      "Unidades",
      "Ventas netas",
    ]);
  });
});

describe("datasetDesdeHistorico", () => {
  // Los campos que manda el endpoint, en SU orden — que no es el de la
  // plantilla, justamente para probar que se permutan y no se asumen.
  const CAMPOS = [
    "date",
    "wmMonth",
    "brand",
    "itemDesc",
    "itemNbr",
    "primeItemNbr",
    "upc",
    "productCode",
    "posQty",
    "posSales",
    "avgPrice",
    "avgSalesPerStore",
    "itemQtySold",
    "basketOccurrences",
  ];
  const FILA = [
    "2024-07-06",
    "2024/07",
    "MARCA",
    "PRODUCTO X",
    101252325,
    101252325,
    "0750229353070",
    "12345",
    3,
    1234.5,
    411.5,
    617.25,
    3,
    2,
  ];
  const armar = (campos = CAMPOS, filas = [FILA]) =>
    datasetDesdeHistorico(WALMART_MENSUAL, campos, filas, "reporte.xlsx");

  it("permuta los valores al orden de la plantilla", () => {
    const { dataset, columnas } = armar();
    const valor = (campo: string) =>
      dataset.filas[0][columnas.find((c) => c.campo === campo)!.indice];
    for (const [i, campo] of CAMPOS.entries()) expect(valor(campo)).toBe(FILA[i]);
  });

  it("deja en null la columna que el servidor no mandó", () => {
    // Si el endpoint deja de enviar un campo, esa columna queda vacía en vez de
    // correr todas las demás una posición.
    const sinMarca = CAMPOS.filter((c) => c !== "brand");
    const { dataset, columnas } = armar(
      sinMarca,
      [FILA.filter((_, i) => CAMPOS[i] !== "brand")]
    );
    const iMarca = columnas.find((c) => c.campo === "brand")!.indice;
    const iDesc = columnas.find((c) => c.campo === "itemDesc")!.indice;
    expect(dataset.filas[0][iMarca]).toBeNull();
    expect(dataset.filas[0][iDesc]).toBe("PRODUCTO X");
  });

  it("elige los mismos filtros por omisión que un archivo con plantilla", () => {
    const { columnas, idxDimension, idxMetrica, idxFecha } = armar();
    expect(columnas[idxDimension].campo).toBe("brand");
    expect(columnas[idxMetrica].campo).toBe("posSales");
    expect(columnas[idxFecha].campo).toBe("date");
  });

  it("sigue sumando todas las métricas aunque el filtro ofrezca dos", () => {
    // La ruta de resumen usa `columnasMetrica` para los acumuladores y no el
    // catálogo de filtros: la tabla de productos de la ficha del retailer pinta
    // una columna por cada una de estas.
    const { columnas } = armar();
    expect(columnasMetrica(columnas).map((c) => c.campo)).toEqual([
      "posQty",
      "posSales",
      "avgPrice",
      "avgSalesPerStore",
      "itemQtySold",
      "basketOccurrences",
    ]);
    // Los códigos no son métricas: sumar UPCs no significa nada.
    expect(columnasMetrica(columnas).map((c) => c.campo)).not.toContain("itemNbr");
    expect(columnasDimension(columnas).map((c) => c.campo)).toContain("brand");
  });

  it("las celdas se formatean igual que las de un Excel", () => {
    const { dataset, columnas } = armar();
    const texto = (campo: string) => {
      const c = columnas.find((x) => x.campo === campo)!;
      return formatearCeldaNormalizada(dataset.filas[0][c.indice], c);
    };
    // La fecha llega en ISO y se queda en ISO, sin corrimiento de zona.
    expect(texto("date")).toBe("2024-07-06");
    // El UPC conserva el cero a la izquierda y el folio no lleva separadores.
    expect(texto("upc")).toBe("0750229353070");
    expect(texto("itemNbr")).toBe("101252325");
    // Las métricas sí llevan formato es-MX, y las que la plantilla declara como
    // importe salen con "$": en la tabla de productos conviven con las de
    // unidades y sin el símbolo se leerían igual.
    expect(texto("posSales")).toBe("$1,234.50");
    // Una métrica que NO es dinero se queda sin símbolo.
    expect(texto("posQty")).toBe("3");
  });

  it("las fechas y los números quedan legibles para las gráficas", () => {
    const { dataset, columnas } = armar();
    const col = (campo: string) => columnas.find((c) => c.campo === campo)!;
    const fila = dataset.filas[0];
    const fecha = valorFecha(fila[col("date").indice], col("date"));
    // Getters LOCALES: si se hubiera construido con new Date("2024-07-06")
    // aquí saldría el 5 de julio en un huso negativo.
    expect(fecha && [fecha.getFullYear(), fecha.getMonth() + 1, fecha.getDate()]).toEqual([
      2024, 7, 6,
    ]);
    expect(valorNumerico(fila[col("posSales").indice], col("posSales"))).toBe(1234.5);
  });

  it("describe el dataset como uno sin encabezado que detectar", () => {
    const { dataset } = armar(CAMPOS, [FILA, FILA]);
    expect(dataset.hoja).toBe("reporte.xlsx");
    expect(dataset.totalFilas).toBe(2);
    // Los nombres vienen declarados por la plantilla, no de una fila del Excel.
    expect(dataset.filaEncabezado).toBe(-1);
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
