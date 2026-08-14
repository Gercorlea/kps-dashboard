import Link from "next/link";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { Badge, Kpi, Panel } from "@/components/ui/basicos";
import { BrandMark } from "@/components/ui/BrandMark";
import { getSessionUser } from "@/lib/auth/guards";
import { canAccess } from "@/lib/rbac";
import { resumenDashboard, UMBRAL_MOH } from "@/lib/retail/stats";
import { fmtFechaHora, fmtNum, fmtPct } from "@/components/lib/fmt";

const TONO_STATUS: Record<string, "ok" | "warn" | "danger" | "neutro"> = {
  procesado: "ok",
  procesando: "warn",
  pendiente: "neutro",
  error: "danger",
};

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
              <Kpi label="Cargas del mes" value={fmtNum(summary.cargasDelMes)} />
              <Kpi
                label="Filas del último corte"
                value={fmtNum(summary.filasUltimoCorte)}
                detalle={summary.ultimoCorte ? `Corte ${summary.ultimoCorte}` : "Sin cortes"}
              />
              <Kpi
                label="Fill rate último corte"
                value={fmtPct(summary.fillRatePromedio)}
              />
              <Kpi
                label={`SKUs con MOH > ${UMBRAL_MOH}`}
                value={fmtNum(summary.skusMohAlto)}
                alerta={summary.skusMohAlto > 0}
              />
            </div>

            <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
              <div className="xl:col-span-2">
                <Panel
                  title="Últimas cargas"
                  acciones={
                    <Link href="/retail" className="cr-btn cr-btn--ghost cr-btn--sm">
                      Ver todas
                    </Link>
                  }
                  sinPadding
                >
                  <div className="cr-table-scroll">
                    <table className="cr-table">
                      <thead>
                        <tr>
                          <th>Archivo</th>
                          <th>Corte</th>
                          <th>Estatus</th>
                          <th className="num">Filas</th>
                          <th>Subida</th>
                        </tr>
                      </thead>
                      <tbody>
                        {summary.ultimasCargas.length === 0 ? (
                          <tr>
                            <td colSpan={5} className="cr-body py-8 text-center">
                              Aún no hay cargas. Sube el primer Excel semanal.
                            </td>
                          </tr>
                        ) : (
                          summary.ultimasCargas.map((c) => (
                            <tr key={c.id}>
                              <td>
                                <Link href={`/retail/${c.id}`} className="cr-link">
                                  {c.filename}
                                </Link>
                              </td>
                              <td className="cr-mono">{c.cutoffDate}</td>
                              <td>
                                <Badge tono={TONO_STATUS[c.status] ?? "neutro"}>{c.status}</Badge>
                              </td>
                              <td className="num">{fmtNum(c.filas)}</td>
                              <td className="cr-mono">{fmtFechaHora(c.createdAt)}</td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </Panel>
              </div>
              <Panel title="Cobertura de datos">
                <dl className="flex flex-col gap-3">
                  <div className="flex items-center justify-between">
                    <dt className="cr-label">Desde</dt>
                    <dd className="cr-mono">{summary.coverage.desde ?? "—"}</dd>
                  </div>
                  <div className="flex items-center justify-between">
                    <dt className="cr-label">Hasta</dt>
                    <dd className="cr-mono">{summary.coverage.hasta ?? "—"}</dd>
                  </div>
                  <div className="flex items-center justify-between">
                    <dt className="cr-label">Cortes disponibles</dt>
                    <dd className="cr-mono">{fmtNum(summary.coverage.cortes)}</dd>
                  </div>
                </dl>
              </Panel>
            </div>
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
