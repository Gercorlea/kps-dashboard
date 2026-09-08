import { describe, expect, it } from "vitest";
import {
  cargasABorrar,
  VENTANA_CARGA_MS,
  type CandidataBarrido,
} from "@/lib/catalogo/cargas";
import type { CatalogLoadStatus } from "@/models/CatalogLoad";

const AHORA = new Date("2026-09-07T12:00:00Z");

function carga(
  loadId: string,
  status: CatalogLoadStatus,
  minutosAtras = 1
): CandidataBarrido {
  return {
    loadId,
    status,
    uploadedAt: new Date(AHORA.getTime() - minutosAtras * 60 * 1000),
  };
}

describe("cargasABorrar", () => {
  it("borra las reemplazadas y las fallidas: ya no las mira nadie", () => {
    const ids = cargasABorrar([carga("a", "replaced"), carga("b", "failed")], AHORA);
    expect(ids.sort()).toEqual(["a", "b"]);
  });

  it("borra una carga abandonada a medio subir", () => {
    const vieja = carga("x", "loading", VENTANA_CARGA_MS / 60_000 + 1);
    expect(cargasABorrar([vieja], AHORA)).toEqual(["x"]);
  });

  it("NO toca una carga en curso: puede ser otra persona subiendo ahora", () => {
    // Es el caso que, mal resuelto, destruye la subida de un compañero.
    expect(cargasABorrar([carga("y", "loading", 5)], AHORA)).toEqual([]);
  });

  it("nunca borra la carga activa", () => {
    expect(cargasABorrar([carga("z", "active", 10_000)], AHORA)).toEqual([]);
  });

  it("es estable en el borde exacto de la ventana", () => {
    const justo = {
      loadId: "j",
      status: "loading" as const,
      uploadedAt: new Date(AHORA.getTime() - VENTANA_CARGA_MS),
    };
    // En el límite todavía no se borra: sólo cuando lo ha pasado.
    expect(cargasABorrar([justo], AHORA)).toEqual([]);
  });

  it("separa lo vigente de lo caduco en una lista mezclada", () => {
    const ids = cargasABorrar(
      [
        carga("activa", "active"),
        carga("vieja", "replaced"),
        carga("rota", "failed"),
        carga("en-curso", "loading", 2),
        carga("abandonada", "loading", 60 * 24),
      ],
      AHORA
    );
    expect(ids.sort()).toEqual(["abandonada", "rota", "vieja"]);
  });
});
