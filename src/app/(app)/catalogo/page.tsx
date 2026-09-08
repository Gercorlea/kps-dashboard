import { redirect } from "next/navigation";
import { CatalogoModulo } from "@/components/catalogo/CatalogoModulo";
import { AccesoDenegado } from "@/components/dashboard/AccesoDenegado";
import { PageHeader } from "@/components/dashboard/PageHeader";
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

  return (
    <>
      <PageHeader
        title="Catálogo"
        description="Los productos de KPS y el código con el que los compra cada cadena"
      />
      <div className="cr-page-content">
        {/* El botón de carga no va en las acciones de la cabecera: necesita el
            input de archivo y el estado de la subida, así que vive dentro del
            componente de cliente, junto a las pestañas. */}
        <CatalogoModulo />
      </div>
    </>
  );
}
