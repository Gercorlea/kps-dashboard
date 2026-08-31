// Lista maestra de permisos del proyecto (§5.4). El sidebar, el guard por
// ruta y la pantalla de admin consumen esta única fuente de verdad.
//
// Un permiso por PÁGINA, no por sección: dentro de Sistema se puede dar
// Estadísticas sin dar Usuarios, y dentro de Proveedores se puede dar la
// bandeja de peticiones sin dar el alta del padrón.

export const MODULES = [
  { id: "retail", name: "Retail" },
  { id: "cronos-ia", name: "KPS AI" },
  { id: "proveedores-alta", name: "Proveedores" },
  { id: "peticiones", name: "Peticiones" },
  { id: "admin-usuarios", name: "Usuarios" },
  { id: "admin-estadisticas", name: "Estadísticas" },
] as const;

export type ModuleId = (typeof MODULES)[number]["id"];

export const MODULE_IDS = MODULES.map((m) => m.id) as ModuleId[];

export const MODULE_NAMES = new Map<string, string>(MODULES.map((m) => [m.id, m.name]));

// Permisos de cuando cada sección era un solo módulo. Ningún alta nueva los
// escribe: sólo se leen, para que un usuario guardado antes del cambio siga
// entrando exactamente donde entraba. La primera vez que se edite a ese
// usuario, el formulario guarda ya los permisos por página y el alias
// desaparece de su ficha.
const ALIAS_LEGADO: Record<string, ModuleId[]> = {
  proveedores: ["proveedores-alta", "peticiones"],
  admin: ["admin-usuarios", "admin-estadisticas"],
};

/** Permisos efectivos: los guardados, más los que abren los alias antiguos. */
export function expandirModulos(modules: readonly string[] | null | undefined): ModuleId[] {
  if (!Array.isArray(modules)) return [];
  const vigentes = new Set<string>(MODULE_IDS);
  const salida = new Set<ModuleId>();
  for (const guardado of modules) {
    for (const id of ALIAS_LEGADO[guardado] ?? [guardado]) {
      if (vigentes.has(id)) salida.add(id as ModuleId);
    }
  }
  return [...salida];
}

export interface RbacUser {
  role: string;
  modules: string[];
}

// La seguridad real vive en el backend: cada route.ts y cada página de
// módulo llama a este predicado, no solo el sidebar.
export function canAccess(user: RbacUser | null | undefined, module: ModuleId): boolean {
  if (!user) return false;
  if (user.role === "superadmin") return true;
  return expandirModulos(user.modules).includes(module);
}

// Secciones del menú (§5.4). El sidebar las pinta y la pantalla de alta de
// usuarios las usa para agrupar los permisos: quien da de alta ve las mismas
// secciones y las mismas páginas que verá después el usuario.
export interface NavItem {
  href: string;
  label: string;
  module: ModuleId | null; // null = visible para cualquier sesión válida
}

export interface NavSection {
  id: string;
  name: string;
  items: NavItem[];
}

export const NAV_SECTIONS: NavSection[] = [
  {
    id: "general",
    name: "General",
    items: [{ href: "/dashboard", label: "Dashboard", module: null }],
  },
  {
    id: "modulos",
    name: "Módulos",
    items: [
      { href: "/retail", label: "Retail", module: "retail" },
      { href: "/cronos-ia", label: "KPS AI", module: "cronos-ia" },
    ],
  },
  {
    id: "proveedores",
    name: "Proveedores",
    items: [
      { href: "/proveedores", label: "Proveedores", module: "proveedores-alta" },
      { href: "/peticiones", label: "Peticiones", module: "peticiones" },
    ],
  },
  {
    id: "sistema",
    name: "Sistema",
    items: [
      { href: "/admin/usuarios", label: "Usuarios", module: "admin-usuarios" },
      { href: "/admin/estadisticas", label: "Estadísticas", module: "admin-estadisticas" },
    ],
  },
];
