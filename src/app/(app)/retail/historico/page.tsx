import { redirect } from "next/navigation";
import { AccesoDenegado } from "@/components/dashboard/AccesoDenegado";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { HistoricoCharts } from "@/components/retail/HistoricoCharts";
import { getSessionUser } from "@/lib/auth/guards";
import { canAccess } from "@/lib/rbac";

export default async function HistoricoPage() {
  const usuario = await getSessionUser();
  if (!usuario) redirect("/login");
  if (!canAccess(usuario, "retail")) return <AccesoDenegado modulo="Retail" />;

  return (
    <>
      <PageHeader
        titulo="Serie histórica"
        descripcion="Venta semanal, inventario, MOH y fill rate a través de los cortes"
      />
      <div className="cr-page-content">
        <HistoricoCharts />
      </div>
    </>
  );
}
