import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
const s = vi.hoisted(() => ({ modules: ["peticiones"], authenticated: true, linked: true, exists: true }));
vi.mock("@/lib/auth/guards", () => ({ requireUser: async () => {
  if (!s.authenticated) throw new ApiError(401, "NO_AUTENTICADO", "Sin sesión");
  return { id: "qa", role: "user", modules: s.modules };
} }));
vi.mock("@/models/proveedores", () => ({
  StoredDocument: () => ({ findById: () => ({ lean: async () => s.exists ? {
    filename: "factura.pdf", contentType: "application/pdf", bytes: { buffer: new TextEncoder().encode("%PDF-archivo-de-prueba") },
  } : null }) }),
  Invoice: () => ({ exists: async () => s.linked ? { _id: "factura" } : null }),
}));
import { GET } from "@/app/api/proveedores/documentos/[key]/route";
const download = () => GET(new Request("http://localhost/api/proveedores/documentos/file"), { params: Promise.resolve({ key: "file" }) });
beforeEach(() => { s.modules = ["peticiones"]; s.authenticated = true; s.linked = true; s.exists = true; });
describe("Adjuntos para revisión de peticiones", () => {
  it("el revisor puede leer los bytes del adjunto de una factura", async () => {
    const r = await download();
    expect(r.status).toBe(200);
    expect(r.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await r.text()).toBe("%PDF-archivo-de-prueba");
  });
  it("peticiones no abre documentos ajenos a las facturas", async () => { s.linked = false; expect((await download()).status).toBe(403); });
  it("el padrón conserva acceso a documentos de alta", async () => { s.modules = ["proveedores-alta"]; s.linked = false; expect((await download()).status).toBe(200); });
  it("otro módulo no puede descargar la factura conociendo su clave", async () => { s.modules = ["retail"]; expect((await download()).status).toBe(403); });
  it("una descarga sin sesión se rechaza", async () => { s.authenticated = false; expect((await download()).status).toBe(401); });
  it("un adjunto inexistente devuelve 404", async () => { s.exists = false; expect((await download()).status).toBe(404); });
});
