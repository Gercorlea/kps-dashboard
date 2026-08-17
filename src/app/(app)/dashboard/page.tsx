import Link from "next/link";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { VentasRetailersChart } from "@/components/dashboard/VentasRetailersChart";
import { Badge, Kpi, Meter, Panel } from "@/components/ui/basicos";
import { BrandMark } from "@/components/ui/BrandMark";
import { getSessionUser } from "@/lib/auth/guards";
import { canAccess } from "@/lib/rbac";
import { colorRetailer } from "@/lib/retail/retailers";
import { MESES_DASHBOARD, resumenDashboard } from "@/lib/retail/stats";
import { fmtFecha, fmtMes, fmtNum, fmtPct } from "@/components/lib/fmt";

export default async function DashboardPage() {
  const usuario = await getSessionUser();
  if (!usuario) redirect("/login");

  const tieneRetail = canAccess(usuario, "retail");
  const summary = tieneRetail ? await resumenDashboard() : null;

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Resumen operativo de KPS Retail"
      />
      <div className="cr-page-content flex flex-col gap-6">
        {summary ? (
          <>
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

            <Panel title="Retailers" sinPadding>
              <div className="cr-table-scroll">
                <table className="cr-table">
                  <thead>
                    <tr>
                      <th>Retailer</th>
                      <th className="num">Unidades {MESES_DASHBOARD} m</th>
                      <th>Participación</th>
                      <th className="num">Meses con venta</th>
                      <th className="num">Reportes</th>
                      <th>Último reporte</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.retailers.map((r) => (
                      <tr key={r.id}>
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
                            <Link href={`/retail/${r.id}`} className="cr-link">
                              {r.nombre}
                            </Link>
                            {r.reportes === 0 ? <Badge>Sin reportes</Badge> : null}
                          </div>
                        </td>
                        <td className="num">{fmtNum(r.unidades)}</td>
                        <td>
                          <div className="flex items-center gap-2">
                            <div className="w-20 shrink-0">
                              <Meter value={r.participacion ?? 0} tono="ink" />
                            </div>
                            <span className="cr-mono">{fmtPct(r.participacion)}</span>
                          </div>
                        </td>
                        <td className="num">{fmtNum(r.meses)}</td>
                        <td className="num">{fmtNum(r.reportes)}</td>
                        <td>
                          <div className="cr-mono">{fmtFecha(r.ultimaCarga)}</div>
                          {r.ultimoArchivo ? (
                            <div
                              className="cr-small max-w-64 truncate"
                              title={r.ultimoArchivo}
                            >
                              {r.ultimoArchivo}
                            </div>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          </>
        ) : (
          <Panel>
            <div className="flex flex-col items-center gap-3 py-12 text-center">
              <BrandMark variant="mark" tone="ink" height={32} />
              <p className="cr-h3">Bienvenido a Cronos Retail</p>
              <p className="cr-body max-w-sm">
                Tu account no tiene el módulo Retail asignado. Usa el menú para ir a los
                módulos disponibles.
              </p>
            </div>
          </Panel>
        )}
      </div>
    </>
  );
}
