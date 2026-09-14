import { redirect } from "next/navigation";
import { AccesoDenegado } from "@/components/dashboard/AccesoDenegado";
import { Pagina } from "@/components/dashboard/Pagina";
import { UsuariosAdmin } from "@/components/dashboard/UsuariosAdmin";
import { getSessionUser } from "@/lib/auth/guards";
import { canAccess } from "@/lib/rbac";

// Gestión de usuarios y permisos (§10). Las mutaciones exigen superadmin
// en el backend; el módulo admin da acceso de lectura.
export default async function AdminUsuariosPage() {
  const usuario = await getSessionUser();
  if (!usuario) redirect("/login");
  if (!canAccess(usuario, "admin-usuarios")) return <AccesoDenegado modulo="Usuarios" />;

  return (
    <Pagina
      title="Usuarios"
      description="Altas, permisos por módulo y control de sesiones"
    >
      <UsuariosAdmin esSuperadmin={usuario.role === "superadmin"} />
    </Pagina>
  );
}
