import Link from "next/link";
import { redirect } from "next/navigation";
import { AccesoDenegado } from "@/components/dashboard/AccesoDenegado";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { VentasRetailersChart } from "@/components/dashboard/VentasRetailersChart";
import { Badge, Kpi, Meter, Panel } from "@/components/ui/basicos";
import { fmtFecha, fmtMes, fmtNum, fmtPct } from "@/components/lib/fmt";
import { getSessionUser } from "@/lib/auth/guards";
import { canAccess } from "@/lib/rbac";
import { colorRetailer } from "@/lib/retail/retailers";
import { detalleRetailers, MESES_DASHBOARD, resumenDashboard } from "@/lib/retail/stats";

// Portada del módulo: los KPIs y la gráfica de ventas —que antes estaban en
// /dashboard— y un retailer por fila. Antes era la bandeja de archivos
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
          <p className="cr-small mb-2">
            Unidades por mes · últimos {MESES_DASHBOARD} meses
          </p>
          <VentasRetailersChart serie={summary.serie} retailers={summary.retailers} />
        </Panel>

        <Panel sinPadding>
          <div className="cr-table-scroll">
            <table className="cr-table">
              <thead>
                <tr>
                  <th>Retailer</th>
                  <th>Periodo</th>
                  <th className="num">Importe</th>
                  <th className="num">Unidades</th>
                  <th className="num">Artículos</th>
                  <th className="num">Reportes</th>
                  <th>Participación</th>
                  <th>Último reporte</th>
                </tr>
              </thead>
              <tbody>
                {retailers.map((r) => {
                  const conDatos = r.reportes > 0;
                  return (
                    <tr key={r.id} className="cr-fila-link">
                      <td>
                        <div className="flex items-center gap-2">
                          <span
                            aria-hidden="true"
                            className="size-2.5 shrink-0"
                            style={{
                              background: colorRetailer(r.id),
                              borderRadius: "var(--cr-r-xs)",
                            }}
                          />
                          {/* El enlace del nombre cubre toda la fila (ver
                              .cr-fila-link): se puede hacer clic en cualquier
                              parte sin meter un <a> por celda. */}
                          <Link href={`/retail/${r.id}`} className="cr-link">
                            {r.nombre}
                          </Link>
                          {conDatos ? null : <Badge>Sin reportes</Badge>}
                        </div>
                      </td>
                      <td className="cr-mono cr-small">
                        {conDatos ? `${fmtFecha(r.desde)} — ${fmtFecha(r.hasta)}` : "—"}
                      </td>
                      <td className="num">{conDatos ? fmtNum(r.importe) : "—"}</td>
                      <td className="num">{conDatos ? fmtNum(r.unidades) : "—"}</td>
                      <td className="num">{conDatos ? fmtNum(r.articulos) : "—"}</td>
                      <td className="num">{fmtNum(r.reportes)}</td>
                      <td>
                        <div className="flex items-center gap-2">
                          <div className="w-20 shrink-0">
                            <Meter value={r.participacion ?? 0} tono="ink" />
                          </div>
                          <span className="cr-mono">{fmtPct(r.participacion)}</span>
                        </div>
                      </td>
                      <td className="cr-mono" title={r.ultimoArchivo ?? undefined}>
                        {fmtFecha(r.ultimoReporte)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Panel>
      </div>
    </>
  );
}
