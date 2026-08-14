import { describe, expect, it } from "vitest";
import { Upload } from "@/models/Upload";

// Regresión: el índice sobre fileHash fue `{ unique: true, sparse: true }` y
// tumbaba la segunda carga con E11000 dup key { fileHash: null }. `sparse` solo
// excluye documentos donde el campo está AUSENTE, pero el esquema escribe un
// `fileHash: null` explícito (default) hasta que la carga se procesa.
describe("índice fileHash de Upload (§6.3)", () => {
  const indice = Upload.schema
    .indexes()
    .find(([campos]) => Object.hasOwn(campos as Record<string, unknown>, "fileHash"));

  it("existe y es único", () => {
    expect(indice).toBeDefined();
    expect(indice?.[1]?.unique).toBe(true);
  });

  it("es parcial y no sparse, para que convivan varias cargas pendientes", () => {
    expect(indice?.[1]?.sparse).toBeUndefined();
    expect(indice?.[1]?.partialFilterExpression).toEqual({ fileHash: { $type: "string" } });
  });
});
