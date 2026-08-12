import { redirect } from "next/navigation";
import { AccesoDenegado } from "@/components/dashboard/AccesoDenegado";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { StatsAdmin } from "@/components/dashboard/StatsAdmin";
import { getSessionUser } from "@/lib/auth/guards";
import { canAccess } from "@/lib/rbac";

export default async function AdminEstadisticasPage() {
  const usuario = await getSessionUser();
  if (!usuario) redirect("/login");
  if (!canAccess(usuario, "admin")) return <AccesoDenegado modulo="Administración" />;

  return (
    <>
      <PageHeader
        titulo="Estadísticas del sistema"
        descripcion="Usuarios, cargas, volúmenes por colección y actividad de Cronos IA"
      />
      <div className="cr-page-content">
        <StatsAdmin />
      </div>
    </>
  );
}
