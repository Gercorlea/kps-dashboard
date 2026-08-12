import Link from "next/link";
import { redirect } from "next/navigation";
import { Upload } from "lucide-react";
import { AccesoDenegado } from "@/components/dashboard/AccesoDenegado";
import { ModuleTabs } from "@/components/dashboard/ModuleTabs";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { CargasTable } from "@/components/retail/CargasTable";
import { getSessionUser } from "@/lib/auth/guards";
import { canAccess } from "@/lib/rbac";

// Guard por página y por módulo (§5.4): además del proxy, cada página de
// módulo verifica el acceso en el servidor.
export default async function RetailPage() {
  const usuario = await getSessionUser();
  if (!usuario) redirect("/login");
  if (!canAccess(usuario, "retail")) return <AccesoDenegado modulo="Retail" />;

  return (
    <>
      <PageHeader
        titulo="Retail"
        descripcion="Cargas semanales de la comercializadora e histórico en MongoDB"
        acciones={
          <Link href="/retail/cargar" className="cr-btn cr-btn--primary">
            <Upload strokeWidth={1.75} />
            Nueva carga
          </Link>
        }
      />
      <div className="cr-page-content flex flex-col gap-4">
        <ModuleTabs usuario={usuario} />
        <CargasTable esSuperadmin={usuario.role === "superadmin"} />
      </div>
    </>
  );
}
