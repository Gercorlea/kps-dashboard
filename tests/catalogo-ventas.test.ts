import { describe, expect, it } from "vitest";
import {
  claveVenta,
  paresCruzables,
  pipelineVentasPorCanal,
  type MapeoCruzable,
} from "@/lib/catalogo/ventas";

function mapeo(over: Partial<MapeoCruzable> = {}): MapeoCruzable {
  return { channel: "walmart", knownRetailer: true, customerCodeNum: 100436765, ...over };
}

describe("paresCruzables", () => {
  it("deja pasar el canal conocido con código numérico", () => {
    expect(paresCruzables([mapeo()])).toEqual([{ account: "walmart", itemNbr: 100436765 }]);
  });

  it("descarta el canal desconocido: no hay ninguna cuenta suya en la base", () => {
    expect(paresCruzables([mapeo({ channel: "super-aki", knownRetailer: false })])).toEqual([]);
  });

  it("descarta el código no numérico en vez de cruzar por lo parecido", () => {
    // Cruzar con un itemNbr inventado le atribuiría a este producto las ventas
    // de otro, y nadie lo detectaría.
    expect(paresCruzables([mapeo({ customerCodeNum: null })])).toEqual([]);
  });

  it("no repite el mismo par: dos filas iguales sumarían doble", () => {
    expect(paresCruzables([mapeo(), mapeo()])).toHaveLength(1);
  });

  it("conserva el mismo producto en canales distintos", () => {
    const pares = paresCruzables([
      mapeo(),
      mapeo({ channel: "san-pablo", customerCodeNum: 999 }),
    ]);
    expect(pares).toEqual([
      { account: "walmart", itemNbr: 100436765 },
      { account: "san-pablo", itemNbr: 999 },
    ]);
  });
});

describe("pipelineVentasPorCanal", () => {
  it("devuelve null sin pares: un $or vacío es un error de Mongo", () => {
    expect(pipelineVentasPorCanal([])).toBeNull();
  });

  it("cruza con itemNbr NUMÉRICO, que es lo que hace usable el índice", () => {
    const p = pipelineVentasPorCanal([{ account: "walmart", itemNbr: 100436765 }]);
    const match = p?.[0] as { $match: { $or: { account: string; itemNbr: unknown }[] } };
    expect(match.$match.$or).toEqual([{ account: "walmart", itemNbr: 100436765 }]);
    // Un string aquí haría que el $match no igualara nunca y que el índice
    // { account, itemNbr, date } no se usara.
    expect(typeof match.$match.$or[0].itemNbr).toBe("number");
  });

  it("agrupa por (cuenta, artículo) sumando unidades e importe", () => {
    const p = pipelineVentasPorCanal([{ account: "walmart", itemNbr: 1 }]);
    const group = p?.[1] as { $group: Record<string, unknown> };
    expect(group.$group._id).toEqual({ account: "$account", itemNbr: "$itemNbr" });
    expect(group.$group.unidades).toEqual({ $sum: "$posQty" });
    expect(group.$group.importe).toEqual({ $sum: "$posSales" });
    expect(group.$group.desde).toEqual({ $min: "$date" });
    expect(group.$group.hasta).toEqual({ $max: "$date" });
  });

  it("arma una rama del $or por cada par", () => {
    const p = pipelineVentasPorCanal([
      { account: "walmart", itemNbr: 1 },
      { account: "heb", itemNbr: 2 },
    ]);
    const match = p?.[0] as { $match: { $or: unknown[] } };
    expect(match.$match.$or).toHaveLength(2);
  });
});

describe("claveVenta", () => {
  it("es la misma clave que produce el agregado", () => {
    expect(claveVenta("walmart", 100436765)).toBe("walmart|100436765");
  });
});
