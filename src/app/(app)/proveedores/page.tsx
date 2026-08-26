import { redirect } from "next/navigation";
import { AccesoDenegado } from "@/components/dashboard/AccesoDenegado";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { ProveedoresAdmin } from "@/components/dashboard/ProveedoresAdmin";
import { getSessionUser } from "@/lib/auth/guards";
import { canAccess } from "@/lib/rbac";

// Alta de proveedores del Portal de Proveedores.
//
// Se administra desde aquí y no desde el portal porque este proyecto es el que
// tiene la conexión con Business One: el padrón sale de SAP en vivo, y lo único
// que se decide es si el proveedor es de mercancía o de servicios.
export default async function ProveedoresPage() {
  const usuario = await getSessionUser();
  if (!usuario) redirect("/login");
  if (!canAccess(usuario, "proveedores")) return <AccesoDenegado modulo="Proveedores" />;

  return (
    <>
      <PageHeader
        title="Proveedores"
        description="Da de alta en el portal proveedores que ya existen en Business One"
      />
      <div className="cr-page-content">
        <ProveedoresAdmin />
      </div>
    </>
  );
}
