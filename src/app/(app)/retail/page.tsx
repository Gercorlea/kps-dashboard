import Link from "next/link";
import { redirect } from "next/navigation";
import { AccesoDenegado } from "@/components/dashboard/AccesoDenegado";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { VentasRetailersChart } from "@/components/dashboard/VentasRetailersChart";
import { RetailerCards } from "@/components/retail/RetailerCards";
import { Kpi, Panel } from "@/components/ui/basicos";
import { fmtMes, fmtNum, fmtPct } from "@/components/lib/fmt";
import { getSessionUser } from "@/lib/auth/guards";
import { canAccess } from "@/lib/rbac";
import { detalleRetailers, MESES_DASHBOARD, resumenDashboard } from "@/lib/retail/stats";

// Portada del módulo: los KPIs y la gráfica de ventas —que antes estaban en
// /dashboard— y una card por retailer. Antes era la bandeja de archivos
// subidos, pero ese flujo se retiró —sus colecciones llevaban tiempo vacías— y
// la unidad de trabajo del módulo pasó a ser el retailer.
//
// Guard por página y por módulo (§5.4): además del proxy, cada página de módulo
// verifica el acceso en el servidor.
export default async function RetailPage() {
  const usuario = await getSessionUser();
  if (!usuario) redirect("/login");
  if (!canAccess(usuario, "retail")) return <AccesoDenegado modulo="Retail" />;

  // Las dos consultas son independientes: van en paralelo para no encadenar dos
  // viajes a Mongo, que es lo lento de la ruta.
  const [retailers, summary] = await Promise.all([detalleRetailers(), resumenDashboard()]);
  const conReportes = retailers.filter((r) => r.reportes > 0).length;

  return (
    <>
      <PageHeader
        title="Retail"
        description="Ventas por retailer a partir de los reportes guardados"
      />
      <div className="cr-page-content flex flex-col gap-6">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Kpi
            label={`Ventas ${MESES_DASHBOARD} meses`}
            value={fmtNum(summary.unidadesTotales)}
            detalle={`Unidades · ${fmtMes(summary.desde)} a ${fmtMes(summary.hasta)}`}
          />
          <Kpi
            label="Ventas del último mes"
            value={fmtNum(summary.unidadesUltimoPeriodo)}
            detalle={
              summary.ultimoPeriodo
                ? `Unidades · ${fmtMes(summary.ultimoPeriodo)}`
                : "Sin ventas registradas"
            }
          />
          <Kpi
            label="Vs mes anterior"
            value={fmtPct(summary.variacionUltimoPeriodo, true)}
            alerta={(summary.variacionUltimoPeriodo ?? 0) < 0}
            detalle={
              summary.periodoPrevio
                ? `${fmtMes(summary.ultimoPeriodo)} contra ${fmtMes(summary.periodoPrevio)}`
                : "Sin mes previo con qué comparar"
            }
          />
          <Kpi
            label="Promedio mensual"
            value={fmtNum(summary.promedioMensual)}
            detalle={
              summary.mesesConVenta > 0
                ? `Sobre ${summary.mesesConVenta} ${summary.mesesConVenta === 1 ? "mes" : "meses"} con venta`
                : "Sin ventas registradas"
            }
          />
        </div>

        <Panel
          title="Ventas por retailer"
          acciones={
            <Link href="/retail/historico" className="cr-btn cr-btn--ghost cr-btn--sm">
              Ver histórico
            </Link>
          }
        >
          <p className="cr-viz-sub">
            Unidades por mes · últimos {MESES_DASHBOARD} meses
          </p>
          <VentasRetailersChart serie={summary.serie} retailers={summary.retailers} />
        </Panel>

        <section className="flex flex-col gap-3">
          <div className="flex items-baseline justify-between gap-3">
            <h3 className="cr-h3">Retailers</h3>
            <span className="cr-small">
              {conReportes} de {retailers.length} con reportes guardados
            </span>
          </div>
          <RetailerCards retailers={retailers} serie={summary.serie} />
        </section>
      </div>
    </>
  );
}
