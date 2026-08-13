// Lista maestra de módulos del proyecto (§5.4). El sidebar, el guard por
// ruta y la pantalla de admin consumen esta única fuente de verdad.

export const MODULES = [
  { id: "retail", name: "Retail" },
  { id: "cronos-ia", name: "KPS AI" },
  { id: "admin", name: "Administración" },
] as const;

export type ModuleId = (typeof MODULES)[number]["id"];

export const MODULE_IDS = MODULES.map((m) => m.id) as ModuleId[];

export interface RbacUser {
  role: string;
  modules: string[];
}

// La seguridad real vive en el backend: cada route.ts y cada página de
// módulo llama a este predicado, no solo el sidebar.
export function canAccess(user: RbacUser | null | undefined, module: ModuleId): boolean {
  if (!user) return false;
  if (user.role === "superadmin") return true;
  return Array.isArray(user.modules) && user.modules.includes(module);
}
