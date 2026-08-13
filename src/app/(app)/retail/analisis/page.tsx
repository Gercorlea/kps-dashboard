import { redirect } from "next/navigation";
import { AccesoDenegado } from "@/components/dashboard/AccesoDenegado";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { AnalisisExcel } from "@/components/retail/AnalisisExcel";
import { getSessionUser } from "@/lib/auth/guards";
import { canAccess } from "@/lib/rbac";

// Análisis exploratorio: a diferencia de /retail/cargar, este Excel NO se sube
// ni se persiste. Se parsea en el navegador para mirar un archivo cualquiera
// sin que tenga que calzar con las hojas fijas de la ingesta (§7).
// Guard por página y por módulo (§5.4).
export default async function AnalisisPage() {
  const usuario = await getSessionUser();
  if (!usuario) redirect("/login");
  if (!canAccess(usuario, "retail")) return <AccesoDenegado modulo="Retail" />;

  return (
    <>
      <PageHeader
        title="Análisis de Excel"
        description="Sube un .xlsx cualquiera para explorar sus datos en crudo y graficarlos; el archivo no sale de tu navegador"
      />
      <div className="cr-page-content">
        <AnalisisExcel />
      </div>
    </>
  );
}
