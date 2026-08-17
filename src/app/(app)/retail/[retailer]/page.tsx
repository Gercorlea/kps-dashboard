import { notFound, redirect } from "next/navigation";
import { AccesoDenegado } from "@/components/dashboard/AccesoDenegado";
import { RetailerDetalle } from "@/components/retail/RetailerDetalle";
import { getSessionUser } from "@/lib/auth/guards";
import { canAccess } from "@/lib/rbac";
import { RETAILERS } from "@/lib/retail/retailers";
import { detalleRetailers } from "@/lib/retail/stats";

// Ficha de un retailer. El slug es el id del retailer ("walmart"), no un
// ObjectId: este espacio de ruta lo ocupaba el detalle de carga, que se retiró
// junto con el resto del flujo de ingesta.
export default async function RetailerPage({
  params,
}: {
  params: Promise<{ retailer: string }>;
}) {
  const usuario = await getSessionUser();
  if (!usuario) redirect("/login");
  if (!canAccess(usuario, "retail")) return <AccesoDenegado modulo="Retail" />;

  const { retailer } = await params;
  // Sólo los retailers declarados: un slug inventado es un 404, no una ficha
  // vacía que parezca un retailer real sin datos.
  if (!RETAILERS.some((r) => r.id === retailer)) notFound();

  const ficha = (await detalleRetailers()).find((r) => r.id === retailer);
  if (!ficha) notFound();

  return <RetailerDetalle ficha={ficha} />;
}
