import { redirect } from "next/navigation";
import { AccesoDenegado } from "@/components/dashboard/AccesoDenegado";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { Uploader } from "@/components/retail/Uploader";
import { getSessionUser } from "@/lib/auth/guards";
import { canAccess } from "@/lib/rbac";

export default async function CargarPage() {
  const usuario = await getSessionUser();
  if (!usuario) redirect("/login");
  if (!canAccess(usuario, "retail")) return <AccesoDenegado modulo="Retail" />;

  return (
    <>
      <PageHeader
        title="Nueva carga"
        description="Sube el Excel semanal de la comercializadora, confirma la fecha de corte y procesa"
      />
      <div className="cr-page-content">
        <Uploader />
      </div>
    </>
  );
}
