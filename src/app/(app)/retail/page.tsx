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
// De ahí el orden: las cards van primero, pegadas a la cabecera. Estaban al
// final y los KPIs más la gráfica —300px fijos más leyenda— las empujaban fuera
// de la primera pantalla, así que se entraba al módulo sin ver aquello en lo que
// se va a trabajar. Los agregados pueden esperar un scroll; el retailer, no.
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

  return (
    <>
      <PageHeader
        title="Retailers"
        description="Abre un retailer para ver su histórico y sus reportes"
      />
      <div className="cr-page-content cr-page-content--pegado flex flex-col gap-5">
        <RetailerCards retailers={retailers} serie={summary.serie} />

        {/* Los agregados leen como un bloque: la fila de KPIs es el titular y
            la gráfica su desglose, así que van más juntos entre sí que con el
            resto de la página. */}
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
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
              positivo={(summary.variacionUltimoPeriodo ?? 0) > 0}
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
          >
            <p className="cr-viz-sub">
              Unidades por mes · últimos {MESES_DASHBOARD} meses
            </p>
            <VentasRetailersChart serie={summary.serie} retailers={summary.retailers} />
          </Panel>
        </div>
      </div>
    </>
  );
}
