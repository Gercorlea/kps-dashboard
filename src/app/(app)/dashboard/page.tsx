import { redirect } from "next/navigation";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { getSessionUser } from "@/lib/auth/guards";

// Portada vacía a propósito: los KPIs y la gráfica de ventas por retailer que
// vivían aquí se movieron a /retail, que es donde está el resto del módulo. La
// ruta se conserva porque es el destino del login y del proxy (§5.4).
export default async function DashboardPage() {
  const usuario = await getSessionUser();
  if (!usuario) redirect("/login");

  return (
    <>
      <PageHeader title="Dashboard" description="Resumen operativo de KPS" />
      <div className="cr-page-content" />
    </>
  );
}
