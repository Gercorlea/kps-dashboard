"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { canAccess, type RbacUser } from "@/lib/rbac";

// Las dos pestañas del producto son navegación real — rutas distintas con
// su propio guard de módulo (§0), renderizadas con el segmented control.
export function ModuleTabs({ usuario }: { usuario: RbacUser }) {
  const pathname = usePathname();
  const tabs = [
    { href: "/retail", etiqueta: "Retail", visible: canAccess(usuario, "retail") },
    { href: "/cronos-ia", etiqueta: "Cronos IA", visible: canAccess(usuario, "cronos-ia") },
  ].filter((t) => t.visible);

  if (tabs.length === 0) return null;

  return (
    <div className="cr-segment" role="tablist">
      {tabs.map((t) => {
        const activo = pathname === t.href || pathname.startsWith(`${t.href}/`);
        return (
          <Link
            key={t.href}
            href={t.href}
            role="tab"
            aria-selected={activo}
            className={`cr-segment__item${activo ? " cr-segment__item--active" : ""}`}
          >
            {t.etiqueta}
          </Link>
        );
      })}
    </div>
  );
}
