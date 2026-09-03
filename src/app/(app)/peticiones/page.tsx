import { redirect } from "next/navigation";
import { AccesoDenegado } from "@/components/dashboard/AccesoDenegado";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { PeticionesAdmin } from "@/components/dashboard/PeticionesAdmin";
import { getSessionUser } from "@/lib/auth/guards";
import { canAccess } from "@/lib/rbac";

// Bandeja de peticiones: las facturas que los proveedores enviaron por el
// portal y esperan que KPS las apruebe, las devuelva o las rechace.
export default async function PeticionesPage() {
  const usuario = await getSessionUser();
  if (!usuario) redirect("/login");
  if (!canAccess(usuario, "peticiones")) return <AccesoDenegado modulo="Peticiones" />;

  return (
    <>
      <PageHeader
        title="Peticiones"
        description="Facturas recibidas por el portal, pendientes de decisión"
      />
      <div className="cr-page-content">
        {/* Archivar es solo de superadmin. El componente es de cliente y no
            puede consultar el rol, así que se decide aquí. Ocultar el botón no
            es la protección: la de verdad la hace `requireSuperadmin` en el
            PATCH, esto solo evita ofrecer algo que va a devolver 403. */}
        <PeticionesAdmin esAdmin={usuario.role === "superadmin"} />
      </div>
    </>
  );
}
