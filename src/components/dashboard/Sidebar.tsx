"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import {
  BarChart3,
  History,
  LayoutDashboard,
  LogOut,
  Menu,
  Sparkles,
  Table2,
  Users,
  X,
} from "lucide-react";
import { BrandMark } from "@/components/ui/BrandMark";
import { canAccess, type ModuleId } from "@/lib/rbac";

export interface UsuarioUI {
  id: string;
  name: string;
  role: "superadmin" | "user";
  modules: string[];
}

interface Item {
  href: string;
  etiqueta: string;
  icono: React.ReactNode;
  modulo: ModuleId | null;
  ai?: boolean;
}

const ITEMS: { seccion: string; items: Item[] }[] = [
  {
    seccion: "General",
    items: [
      { href: "/dashboard", etiqueta: "Dashboard", icono: <LayoutDashboard strokeWidth={1.75} />, modulo: null },
    ],
  },
  {
    seccion: "Módulos",
    items: [
      { href: "/retail", etiqueta: "Retail", icono: <Table2 strokeWidth={1.75} />, modulo: "retail" },
      { href: "/retail/historico", etiqueta: "Histórico", icono: <History strokeWidth={1.75} />, modulo: "retail" },
      { href: "/cronos-ia", etiqueta: "KPS AI", icono: <Sparkles strokeWidth={1.75} />, modulo: "cronos-ia", ai: true },
    ],
  },
  {
    seccion: "Sistema",
    items: [
      { href: "/admin/usuarios", etiqueta: "Usuarios", icono: <Users strokeWidth={1.75} />, modulo: "admin" },
      { href: "/admin/estadisticas", etiqueta: "Estadísticas", icono: <BarChart3 strokeWidth={1.75} />, modulo: "admin" },
    ],
  },
];

function esActivo(pathname: string, href: string): boolean {
  if (href === "/retail") return pathname === "/retail" || (pathname.startsWith("/retail/") && !pathname.startsWith("/retail/historico"));
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function Sidebar({ usuario }: { usuario: UsuarioUI }) {
  const pathname = usePathname();
  const router = useRouter();
  const [abierto, setAbierto] = useState(false);

  // El menú se renderiza según los módulos del usuario; la seguridad real
  // está en el backend, no en ocultar el link (§5.4).
  const secciones = ITEMS.map((s) => ({
    ...s,
    items: s.items.filter((i) => i.modulo === null || canAccess(usuario, i.modulo)),
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
          <div key={s.seccion}>
            <div className="cr-sidebar__section">
              <span className="cr-label">{s.seccion}</span>
            </div>
            {s.items.map((i) => {
              const activo = esActivo(pathname, i.href);
              const clases = ["cr-navlink"];
              if (i.ai) clases.push("cr-navlink--ai");
              if (activo) clases.push("cr-navlink--active");
              return (
                <Link key={i.href} href={i.href} className={clases.join(" ")} onClick={() => setAbierto(false)}>
                  {i.icono}
                  {i.etiqueta}
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
