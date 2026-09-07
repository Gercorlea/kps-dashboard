import { redirect } from "next/navigation";
import { AccesoDenegado } from "@/components/dashboard/AccesoDenegado";
import { Pagina } from "@/components/dashboard/Pagina";
import { StatsAdmin } from "@/components/dashboard/StatsAdmin";
import { getSessionUser } from "@/lib/auth/guards";
import { canAccess } from "@/lib/rbac";

export default async function AdminEstadisticasPage() {
  const usuario = await getSessionUser();
  if (!usuario) redirect("/login");
  if (!canAccess(usuario, "admin-estadisticas")) return <AccesoDenegado modulo="Estadísticas" />;

  return (
    <Pagina
      title="Estadísticas del sistema"
      description="Usuarios, cargas, volúmenes por colección y actividad de KPS AI"
    >
      <StatsAdmin />
    </Pagina>
  );
}
