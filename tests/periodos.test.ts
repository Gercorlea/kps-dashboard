import { describe, expect, it } from "vitest";
import { estadoDelPeriodo, ventanaDelRango } from "@/lib/retail/analisis/periodos";

// El periodo de la ficha del retailer se escribe a mano (Desde / Hasta). Lo que
// se fija aquí es cuándo ese tramo se puede comparar con "el mismo del año
// pasado", que es de lo que se fía la comparativa anual de la pestaña Ventas.

describe("estadoDelPeriodo", () => {
  it("los dos en blanco es no tener filtro", () => {
    expect(estadoDelPeriodo("", "")).toBe("vacio");
  });

  it("con una sola fecha NO se aplica nada", () => {
    // Es el caso que se arregló: elegir el inicio movía las gráficas —y costaba
    // el viaje del bundle acotado— para un periodo que nadie pidió.
    expect(estadoDelPeriodo("2026-01-01", "")).toBe("incompleto");
    expect(estadoDelPeriodo("", "2026-03-31")).toBe("incompleto");
  });

  it("las dos y en orden es el único caso que se pide", () => {
    expect(estadoDelPeriodo("2026-01-01", "2026-03-31")).toBe("listo");
    // Un solo día es un rango válido: es el periodo de una fecha.
    expect(estadoDelPeriodo("2026-01-01", "2026-01-01")).toBe("listo");
  });

  it("al revés tampoco se aplica", () => {
    expect(estadoDelPeriodo("2026-03-31", "2026-01-01")).toBe("invertido");
  });
});

describe("ventanaDelRango", () => {
  it("un trimestre da sus tres meses y su año", () => {
    expect(ventanaDelRango("2026-01-01", "2026-03-31")).toEqual({ anio: 2026, meses: [1, 2, 3] });
  });

  it("un mes suelto da un solo mes", () => {
    expect(ventanaDelRango("2026-02-01", "2026-02-28")).toEqual({ anio: 2026, meses: [2] });
  });

  it("el año completo da los doce", () => {
    expect(ventanaDelRango("2025-01-01", "2025-12-31")).toEqual({
      anio: 2025,
      meses: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    });
  });

  it("cuenta los meses que TOCA, aunque el tramo empiece y acabe a media semana", () => {
    // Del 12 de febrero al 3 de abril entran febrero, marzo y abril: la serie
    // es mensual y esos son los buckets que aparecen.
    expect(ventanaDelRango("2026-02-12", "2026-04-03")).toEqual({ anio: 2026, meses: [2, 3, 4] });
  });

  it("a caballo entre dos años no hay 'el año anterior'", () => {
    expect(ventanaDelRango("2025-08-01", "2026-07-31")).toBeNull();
    expect(ventanaDelRango("2025-12-31", "2026-01-01")).toBeNull();
  });
});
