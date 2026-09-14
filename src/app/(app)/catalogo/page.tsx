import { redirect } from "next/navigation";
import { CatalogoModulo } from "@/components/catalogo/CatalogoModulo";
import { AccesoDenegado } from "@/components/dashboard/AccesoDenegado";
import { getSessionUser } from "@/lib/auth/guards";
import { canAccess } from "@/lib/rbac";

// Catálogo de productos de KPS y su mapeo por cadena.
//
// El Excel que sube el encargado es la fuente de verdad: cada carga reemplaza a
// la anterior y el módulo muestra sólo la última.
export default async function CatalogoPage() {
  const usuario = await getSessionUser();
  if (!usuario) redirect("/login");
  if (!canAccess(usuario, "catalogo")) return <AccesoDenegado modulo="Catálogo" />;

  return <CatalogoModulo />;
}
