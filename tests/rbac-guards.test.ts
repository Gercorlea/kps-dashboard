import { beforeAll, describe, expect, it, vi } from "vitest";
import { canAccess, expandirModulos } from "@/lib/rbac";

process.env.JWT_SECRET = "secreto-de-prueba-para-vitest";
process.env.JWT_REFRESH_SECRET = "otro-secreto-de-prueba";

let cookieValue: string | null = null;
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "cr_access" && cookieValue ? { value: cookieValue } : undefined,
  }),
}));

describe("canAccess (§5.4)", () => {
  it("superadmin accede a todo", () => {
    const u = { role: "superadmin", modules: [] };
    expect(canAccess(u, "retail")).toBe(true);
    expect(canAccess(u, "cronos-ia")).toBe(true);
    expect(canAccess(u, "admin-usuarios")).toBe(true);
  });

  it("user solo accede a sus módulos asignados", () => {
    const u = { role: "user", modules: ["retail"] };
    expect(canAccess(u, "retail")).toBe(true);
    expect(canAccess(u, "cronos-ia")).toBe(false);
    expect(canAccess(u, "admin-usuarios")).toBe(false);
  });

  // El permiso es por página: dar Estadísticas no puede colar Usuarios.
  it("dentro de una sección los permisos no se arrastran entre sí", () => {
    const u = { role: "user", modules: ["admin-estadisticas"] };
    expect(canAccess(u, "admin-estadisticas")).toBe(true);
    expect(canAccess(u, "admin-usuarios")).toBe(false);

    const v = { role: "user", modules: ["peticiones"] };
    expect(canAccess(v, "peticiones")).toBe(true);
    expect(canAccess(v, "proveedores-alta")).toBe(false);
  });

  // Quien se guardó cuando cada sección era un solo módulo tiene que seguir
  // entrando donde entraba, sin migrar nada en Mongo.
  it("los permisos antiguos abren toda su sección", () => {
    const u = { role: "user", modules: ["admin", "proveedores"] };
    expect(canAccess(u, "admin-usuarios")).toBe(true);
    expect(canAccess(u, "admin-estadisticas")).toBe(true);
    expect(canAccess(u, "proveedores-alta")).toBe(true);
    expect(canAccess(u, "peticiones")).toBe(true);
    expect(canAccess(u, "retail")).toBe(false);
  });

  it("expandirModulos descarta lo que ya no existe y no duplica", () => {
    expect(expandirModulos(["admin", "admin-usuarios", "inventado"]).sort()).toEqual([
      "admin-estadisticas",
      "admin-usuarios",
    ]);
    expect(expandirModulos(null)).toEqual([]);
  });

  it("sin usuario no hay acceso", () => {
    expect(canAccess(null, "retail")).toBe(false);
  });
});

describe("guards de módulo (§5.4: 403 real, no solo link oculto)", () => {
  beforeAll(async () => {
    const { signAccessToken } = await import("@/lib/auth/jwt");
    cookieValue = await signAccessToken({
      sub: "64b000000000000000000001",
      role: "user",
      modules: ["cronos-ia"],
    });
  });

  it("un usuario sin el módulo retail recibe 403", async () => {
    const { requireModule } = await import("@/lib/auth/guards");
    const { ApiError } = await import("@/lib/api");
    await expect(requireModule("retail")).rejects.toMatchObject({
      status: 403,
    });
    await expect(requireModule("retail")).rejects.toBeInstanceOf(ApiError);
  });

  it("con el módulo asignado pasa el guard", async () => {
    const { requireModule } = await import("@/lib/auth/guards");
    const user = await requireModule("cronos-ia");
    expect(user.id).toBe("64b000000000000000000001");
  });

  it("sin cookie el guard responde 401", async () => {
    cookieValue = null;
    const { requireUser } = await import("@/lib/auth/guards");
    await expect(requireUser()).rejects.toMatchObject({ status: 401 });
  });
});
