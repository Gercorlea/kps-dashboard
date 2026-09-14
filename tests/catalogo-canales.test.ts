import { describe, expect, it } from "vitest";
import { idCanal, resolverCanal } from "@/lib/catalogo/canales";
import { RETAILERS } from "@/lib/retail/retailers";

// El slug que produce el cliente tiene que pasar la validación del servidor;
// si no, la carga se rechazaría por un canal que el archivo trae legítimamente.
const REGEX_SERVIDOR = /^[a-z0-9][a-z0-9-]{0,59}$/;

describe("resolverCanal — los retailers del módulo", () => {
  it("reconoce cada retailer por su id", () => {
    for (const r of RETAILERS) {
      expect(resolverCanal(r.id), r.id).toEqual({ id: r.id, nombre: r.nombre, conocido: true });
    }
  });

  it("reconoce cada retailer por su nombre oficial", () => {
    // Es lo que permite que el Excel escriba "San Pablo" o "san-pablo".
    for (const r of RETAILERS) {
      expect(resolverCanal(r.nombre), r.nombre).toEqual({
        id: r.id,
        nombre: r.nombre,
        conocido: true,
      });
    }
  });

  it("tolera caja, acentos y espacios sobrantes", () => {
    expect(resolverCanal("  WALMART ").id).toBe("walmart");
    expect(resolverCanal("San Pablo ").id).toBe("san-pablo");
    expect(resolverCanal("farmacias del ahorro").id).toBe("farmacias-del-ahorro");
    expect(resolverCanal("HEB").id).toBe("heb");
  });
});

describe("resolverCanal — canales que el módulo no conoce", () => {
  it("los acepta marcados en vez de perder la fila", () => {
    // El archivo trae cadenas que todavía no son retailers; descartarlas sería
    // perder el trabajo de quien mantiene el Excel.
    expect(resolverCanal("Súper Aki")).toEqual({
      id: "super-aki",
      nombre: "Súper Aki",
      conocido: false,
    });
  });

  it("conserva el texto original como nombre para mostrar", () => {
    expect(resolverCanal("Tiendas 3B").nombre).toBe("Tiendas 3B");
    expect(resolverCanal("Tiendas 3B").id).toBe("tiendas-3b");
  });

  it("devuelve vacío para una celda vacía, que el lector descarta", () => {
    expect(resolverCanal("  ")).toEqual({ id: "", nombre: "", conocido: false });
    expect(resolverCanal(null)).toEqual({ id: "", nombre: "", conocido: false });
  });
});

describe("idCanal", () => {
  it("produce siempre un slug que el servidor acepta", () => {
    const entradas = [
      "walmart", "San Pablo", "Farmacias del Ahorro", "HEB", "Súper Aki",
      "Tiendas 3B", "  espacios  ", "con.puntos", "guion-medio", "Ñoño",
    ];
    for (const t of entradas) {
      const id = idCanal(t);
      expect(REGEX_SERVIDOR.test(id), `${t} → ${id}`).toBe(true);
    }
  });

  it("no deja guiones sueltos en los extremos", () => {
    expect(idCanal("--walmart--")).toBe("walmart");
    expect(idCanal("(walmart)")).toBe("walmart");
  });

  it("los cuatro retailers tienen id igual al slug de su nombre", () => {
    // Es el supuesto en el que se apoya resolverCanal para reconocer un canal
    // escrito con el nombre oficial; si se añade un retailer que lo rompa, este
    // test lo dice antes de que el cruce falle en silencio.
    for (const r of RETAILERS) {
      expect(idCanal(r.nombre), r.nombre).toBe(r.id);
    }
  });
});
