"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import {
  LayoutDashboard,
  LogOut,
  Menu,
  Sparkles,
  Table2,
  Inbox,
  Truck,
  Users,
  X,
} from "lucide-react";
import { BrandMark } from "@/components/ui/BrandMark";
import { canAccess, NAV_SECTIONS } from "@/lib/rbac";

export interface UsuarioUI {
  id: string;
  name: string;
  role: "superadmin" | "user";
  modules: string[];
}

// El árbol del menú vive en lib/rbac (lo comparte la pantalla de usuarios);
// aquí solo se le cuelga la parte visual: el icono y el acento de KPS AI.
const ICONOS: Record<string, React.ReactNode> = {
  "/dashboard": <LayoutDashboard strokeWidth={1.75} />,
  "/retail": <Table2 strokeWidth={1.75} />,
  "/cronos-ia": <Sparkles strokeWidth={1.75} />,
  "/proveedores": <Truck strokeWidth={1.75} />,
  "/peticiones": <Inbox strokeWidth={1.75} />,
  "/admin/usuarios": <Users strokeWidth={1.75} />,
};

const HREFS_AI = new Set(["/cronos-ia"]);

// Cada link cubre sus subrutas. Ninguna subruta de /retail tiene entrada propia
// en el menú —a /retail/analisis y a la ficha de un retailer se entra desde la
// lista—, así que "Retail" es el único link que puede encenderse en /retail/*.
function esActivo(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function Sidebar({ usuario }: { usuario: UsuarioUI }) {
  const pathname = usePathname();
  const router = useRouter();
  const [abierto, setAbierto] = useState(false);

  // El menú se renderiza según los módulos del usuario; la seguridad real
  // está en el backend, no en ocultar el link (§5.4).
  const secciones = NAV_SECTIONS.map((s) => ({
    ...s,
    items: s.items.filter((i) => i.module === null || canAccess(usuario, i.module)),
  })).filter((s) => s.items.length > 0);

  async function cerrarSesion() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  const nav = (
    <>
      <div className="cr-sidebar__head">
        <Link href="/dashboard" className="flex items-center gap-2.5" onClick={() => setAbierto(false)}>
          <BrandMark variant="mark" tone="ink" height={28} priority />
          <BrandMark variant="word" tone="ink" height={14} />
        </Link>
        <button
          type="button"
          className="cr-btn cr-btn--ghost cr-btn--sm ml-auto lg:hidden"
          onClick={() => setAbierto(false)}
          aria-label="Cerrar menú"
        >
          <X strokeWidth={1.75} />
        </button>
      </div>
      <nav className="cr-sidebar__nav">
        {secciones.map((s) => (
          <div key={s.id}>
            <div className="cr-sidebar__section">
              <span className="cr-label">{s.name}</span>
            </div>
            {s.items.map((i) => {
              const activo = esActivo(pathname, i.href);
              const clases = ["cr-navlink"];
              if (HREFS_AI.has(i.href)) clases.push("cr-navlink--ai");
              if (activo) clases.push("cr-navlink--active");
              return (
                <Link key={i.href} href={i.href} className={clases.join(" ")} onClick={() => setAbierto(false)}>
                  {ICONOS[i.href]}
                  {i.label}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>
      <div className="border-t p-3" style={{ borderColor: "var(--cr-line-soft)" }}>
        <div className="cr-small px-2 pb-2 truncate">{usuario.name}</div>
        <button type="button" className="cr-navlink w-full" onClick={cerrarSesion}>
          <LogOut strokeWidth={1.75} />
          Cerrar sesión
        </button>
      </div>
    </>
  );

  return (
    <>
      <header className="cr-mobile-nav">
        <button
          type="button"
          className="cr-btn cr-btn--ghost cr-btn--sm"
          onClick={() => setAbierto(true)}
          aria-label="Abrir menú"
        >
          <Menu strokeWidth={1.75} />
        </button>
        <Link href="/dashboard" className="flex items-center gap-2">
          <BrandMark variant="mark" tone="ink" height={24} />
          <BrandMark variant="word" tone="ink" height={12} />
        </Link>
      </header>
      {abierto ? <div className="cr-backdrop lg:hidden" onClick={() => setAbierto(false)} /> : null}
      <aside className={`cr-sidebar${abierto ? " cr-sidebar--open" : ""}`}>{nav}</aside>
    </>
  );
}
