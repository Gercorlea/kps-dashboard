import { redirect } from "next/navigation";
import { AccesoDenegado } from "@/components/dashboard/AccesoDenegado";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { UsuariosAdmin } from "@/components/dashboard/UsuariosAdmin";
import { getSessionUser } from "@/lib/auth/guards";
import { canAccess } from "@/lib/rbac";

// Gestión de usuarios y permisos (§10). Las mutaciones exigen superadmin
// en el backend; el módulo admin da acceso de lectura.
export default async function AdminUsuariosPage() {
  const usuario = await getSessionUser();
  if (!usuario) redirect("/login");
  if (!canAccess(usuario, "admin")) return <AccesoDenegado modulo="Administración" />;

  return (
    <>
      <PageHeader
        titulo="Usuarios"
        descripcion="Altas, permisos por módulo y control de sesiones"
      />
      <div className="cr-page-content">
        <UsuariosAdmin esSuperadmin={usuario.role === "superadmin"} />
      </div>
    </>
  );
}
