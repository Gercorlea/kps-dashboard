import { describe, expect, it } from "vitest";
import { Types } from "mongoose";
import {
  filasDelArchivo,
  operacionDeFila,
  pipelineFilasPorArchivo,
  reportesListados,
} from "@/lib/retail/importaciones";
import { SalesReport } from "@/models/SalesReport";

// Lo que este archivo protege es una sola idea: la pertenencia de una fila a un
// archivo es de MUCHOS A MUCHOS. Cuando era un escalar, subir un reporte que se
// solapa con otro le quitaba al primero las filas compartidas —desaparecían de
// su conteo, de su periodo y de sus totales, y su botón de borrar se llevaba
// filas ajenas—. Cada prueba fija una de las piezas que lo impiden.

const PROC = {
  template: "walmart-mensual",
  account: "walmart",
  sourceFile: "feb-mar.xlsx",
  importedAt: new Date("2026-03-01T10:00:00Z"),
  importedBy: new Types.ObjectId(),
};

const FILA = { itemNbr: 555, date: "2026-03-15", posQty: 3, brand: "ACME" };

describe("operacionDeFila", () => {
  const op = operacionDeFila(FILA, new Date("2026-03-15T00:00:00Z"), PROC).updateOne;

  it("acumula la procedencia en vez de pisarla", () => {
    // El corazón del arreglo. Si esto volviera a ser un $set, el segundo
    // reporte le quitaría las filas de marzo al primero.
    expect(op.update.$addToSet).toEqual({ sourceFiles: "feb-mar.xlsx" });
    expect(op.update.$set).not.toHaveProperty("sourceFiles");
    expect(op.update.$set).not.toHaveProperty("sourceFile");
  });

  it("pisa las métricas: gana la última carga", () => {
    // La decisión contraria a la de arriba, y a propósito: dos archivos que
    // traen el mismo registro con cifras distintas dejan las del más reciente.
    expect(op.update.$set).toMatchObject({ posQty: 3, brand: "ACME" });
  });

  it("filtra por la clave natural, que no incluye el archivo", () => {
    // Es lo que garantiza UN documento por (account, itemNbr, date): sin esto
    // la fila compartida se duplicaría en la base y en las gráficas.
    expect(op.filter).toEqual({
      account: "walmart",
      itemNbr: 555,
      date: new Date("2026-03-15T00:00:00Z"),
    });
    expect(op.upsert).toBe(true);
  });

  it("no manda la fecha como texto", () => {
    // `date` llega en ISO desde el navegador y se ancla a medianoche UTC; que
    // se colara el texto rompería el filtro y duplicaría la fila.
    expect(op.update.$set.date).toBeInstanceOf(Date);
  });
});

describe("filasDelArchivo", () => {
  it("pregunta por contención, no por igualdad", () => {
    // Mongo compara un escalar contra un arreglo por contención, así que esto
    // encuentra la fila tanto si el archivo es su único dueño como si la
    // comparte. Es lo que hace que los DOS reportes la muestren.
    expect(filasDelArchivo("walmart", "feb-mar.xlsx")).toEqual({
      account: "walmart",
      sourceFiles: "feb-mar.xlsx",
    });
  });
});

describe("pipelineFilasPorArchivo", () => {
  const etapas = pipelineFilasPorArchivo({ account: "walmart" });

  it("desdobla la membresía para contar la fila en los dos archivos", () => {
    expect(etapas).toEqual([
      { $match: { account: "walmart" } },
      { $project: { sourceFiles: 1 } },
      { $unwind: "$sourceFiles" },
      { $group: { _id: "$sourceFiles", filas: { $sum: 1 } } },
    ]);
  });

  it("proyecta antes de desdoblar", () => {
    // Sin el $project, cada fila desdoblada arrastra las métricas y las
    // dimensiones del reporte por la tubería.
    const iProject = etapas.findIndex((e) => "$project" in e);
    const iUnwind = etapas.findIndex((e) => "$unwind" in e);
    expect(iProject).toBeLessThan(iUnwind);
  });
});

describe("reportesListados", () => {
  const autor = new Types.ObjectId();
  const reportes = [
    {
      sourceFile: "feb-mar.xlsx",
      importedAt: new Date("2026-03-01T10:00:00Z"),
      reimportedAt: null,
      importedBy: autor,
    },
    {
      sourceFile: "mar-abr.xlsx",
      importedAt: new Date("2026-04-01T10:00:00Z"),
      reimportedAt: new Date("2026-04-05T10:00:00Z"),
      importedBy: autor,
    },
  ];

  it("cuenta la fila compartida en los dos reportes", () => {
    // 8200 + 7600 = 15800 sobre un histórico de 13900 filas únicas: la suma de
    // la columna es MAYOR que el total, y eso es exactamente lo que se pide
    // mostrar. Un solo documento, dos reportes que lo contienen.
    const listado = reportesListados(reportes, [
      { _id: "feb-mar.xlsx", filas: 8200 },
      { _id: "mar-abr.xlsx", filas: 7600 },
    ]);
    expect(listado.map((r) => r.filas)).toEqual([8200, 7600]);
  });

  it("no cruza las fechas de un reporte con las del otro", () => {
    // El enredo que motivó todo el andamiaje viejo: mar-abr heredaba las filas
    // de marzo y con ellas la fecha de carga de feb-mar, y salía "importado" el
    // día del primero. Cada reporte se fecha por su propio documento.
    const listado = reportesListados(reportes, []);
    expect(listado[0].importado).toEqual(new Date("2026-03-01T10:00:00Z"));
    expect(listado[0].actualizado).toBeNull();
    expect(listado[1].importado).toEqual(new Date("2026-04-01T10:00:00Z"));
    expect(listado[1].actualizado).toEqual(new Date("2026-04-05T10:00:00Z"));
  });

  it("muestra en cero el reporte que se quedó sin filas", () => {
    // Pasa cuando todas las suyas se borraron desde otro reporte que también
    // las tenía. Hacer desaparecer la fila escondería el estado.
    expect(reportesListados(reportes, [])[0].filas).toBe(0);
  });
});

describe("esquema de SalesReport", () => {
  const indices = SalesReport.schema.indexes().map(([claves]) => Object.keys(claves).join(","));

  it("mantiene única la clave natural", () => {
    // Es lo único que impide que compartir una fila entre dos archivos la
    // duplique en la colección.
    const natural = SalesReport.schema
      .indexes()
      .find(([c]) => Object.keys(c).join(",") === "account,itemNbr,date");
    expect(natural?.[1]).toMatchObject({ unique: true });
  });

  it("indexa la membresía y deja atrás el escalar", () => {
    expect(indices).toContain("account,sourceFiles,date,itemNbr");
    expect(indices.some((i) => i.includes("firstSourceFile"))).toBe(false);
    expect(indices.some((i) => i.split(",").includes("sourceFile"))).toBe(false);
  });

  it("no deja que el default del arreglo choque con el $addToSet", () => {
    // En un upsert, Mongoose puede adelantar los defaults del esquema en un
    // $setOnInsert. Si `sourceFiles` cayera ahí junto al $addToSet del mismo
    // path, MongoDB tumbaría el bulkWrite ENTERO con "would create a conflict"
    // y la carga fallaría en bloque. Esta versión no lo hace; el test lo fija.
    // `_castUpdate` es interno de Mongoose y no está en sus tipos, pero es
    // justo la etapa donde se decidiría el conflicto: no hay forma pública de
    // observarla sin una base de datos.
    interface QueryInterna {
      _castUpdate(update: unknown, conditions: unknown): void;
      _update: { $setOnInsert?: Record<string, unknown>; $addToSet?: Record<string, unknown> };
      _conditions: unknown;
    }
    const q = SalesReport.updateOne(
      { account: "walmart", itemNbr: 1, date: new Date(0) },
      operacionDeFila(FILA, new Date(0), PROC).updateOne.update,
      { upsert: true }
    ) as unknown as QueryInterna;
    q._castUpdate(q._update, q._conditions);
    expect(q._update.$setOnInsert ?? {}).not.toHaveProperty("sourceFiles");
    expect(q._update.$addToSet).toHaveProperty("sourceFiles");
  });
});
