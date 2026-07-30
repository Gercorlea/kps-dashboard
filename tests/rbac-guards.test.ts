import { beforeAll, describe, expect, it, vi } from "vitest";
import { canAccess } from "@/lib/rbac";

process.env.JWT_SECRET = "secreto-de-prueba-para-vitest";
process.env.JWT_REFRESH_SECRET = "otro-secreto-de-prueba";

let cookieValue: string | null = null;
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (nombre: string) =>
      nombre === "cr_access" && cookieValue ? { value: cookieValue } : undefined,
  }),
}));

describe("canAccess (§5.4)", () => {
  it("superadmin accede a todo", () => {
    const u = { role: "superadmin", modules: [] };
    expect(canAccess(u, "retail")).toBe(true);
    expect(canAccess(u, "cronos-ia")).toBe(true);
    expect(canAccess(u, "admin")).toBe(true);
  });

  it("user solo accede a sus módulos asignados", () => {
    const u = { role: "user", modules: ["retail"] };
    expect(canAccess(u, "retail")).toBe(true);
    expect(canAccess(u, "cronos-ia")).toBe(false);
    expect(canAccess(u, "admin")).toBe(false);
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
