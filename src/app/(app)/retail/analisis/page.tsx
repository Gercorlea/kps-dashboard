import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AccesoDenegado } from "@/components/dashboard/AccesoDenegado";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { AnalisisExcel } from "@/components/retail/AnalisisExcel";
import { getSessionUser } from "@/lib/auth/guards";
import { canAccess } from "@/lib/rbac";
import { nombreRetailer, RETAILERS } from "@/lib/retail/retailers";

// Carga de un Excel para UN retailer. A esta ruta se entra desde la ficha del
// retailer (/retail/[retailer]) y sólo desde ahí: ya no tiene entrada en el
// menú, y el retailer viaja en `?retailer=` porque es lo que decide en qué
// cuenta se guarda el reporte. Sin ese parámetro no hay cuenta a la que
// guardar, así que se manda de vuelta a elegir retailer en vez de mostrar un
// analizador que no puede guardar nada.
// Guard por página y por módulo (§5.4).
export default async function AnalisisPage({
  searchParams,
}: {
  searchParams: Promise<{ retailer?: string | string[] }>;
}) {
  const usuario = await getSessionUser();
  if (!usuario) redirect("/login");
  if (!canAccess(usuario, "retail")) return <AccesoDenegado modulo="Retail" />;

  const { retailer } = await searchParams;
  const id = Array.isArray(retailer) ? retailer[0] : retailer;
  if (!id || !RETAILERS.some((r) => r.id === id)) redirect("/retail");

  return (
    <>
      <PageHeader
        title={`Cargar un Excel · ${nombreRetailer(id)}`}
        description={`Sube el .xlsx del reporte: se analiza en tu navegador y se guarda solo en el histórico de ${nombreRetailer(id)}`}
        acciones={
          // La vuelta al panel del que se vino. Va aquí y no en el <AnalisisExcel>
          // porque el retailer es el mismo de la URL y no depende de nada que
          // pase en el cliente.
          <Link href={`/retail/${id}`} className="cr-btn cr-btn--secondary cr-btn--sm">
            <ArrowLeft strokeWidth={1.75} />
            Volver a {nombreRetailer(id)}
          </Link>
        }
      />
      <div className="cr-page-content flex flex-col gap-5">
        <AnalisisExcel retailer={id} />
      </div>
    </>
  );
}
