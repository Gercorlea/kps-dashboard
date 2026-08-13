import { isValidObjectId } from "mongoose";
import { notFound, redirect } from "next/navigation";
import { AccesoDenegado } from "@/components/dashboard/AccesoDenegado";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { Badge, Meter, Panel } from "@/components/ui/basicos";
import { fmtNum } from "@/components/lib/fmt";
import { getSessionUser } from "@/lib/auth/guards";
import { connectDB } from "@/lib/db";
import { canAccess } from "@/lib/rbac";
import { fechaISO } from "@/lib/retail/normalize";
import {
  fmtMoh,
  fmtPct,
  fmtUnidades,
  generarScorecard,
  type BloqueScorecard,
} from "@/lib/retail/scorecard";
import { Upload } from "@/models/Upload";

// El scorecard es un output GENERADO desde el histórico persistido (§8):
// mismas cifras en cada ejecución, narrativa por plantilla determinista.
function TablaBloque({ bloque }: { bloque: BloqueScorecard }) {
  if (bloque.filasFillRate) {
    return (
      <div className="cr-table-scroll">
        <table className="cr-table">
          <thead>
            <tr>
              <th>Etiqueta</th>
              <th className="num">Unidades pedidas</th>
              <th className="num">Unidades entregadas</th>
              <th className="num">Fill rate</th>
              <th style={{ width: "18%" }}>Avance</th>
            </tr>
          </thead>
          <tbody>
            {bloque.filasFillRate.map((f, i) =>
              f.esSubtotal && f.fillRate === null && f.pedidas === 0 ? (
                <tr key={i}>
                  <td colSpan={5}>
                    <span className="cr-label">{f.etiqueta}</span>
                  </td>
                </tr>
              ) : (
                <tr key={i} style={f.esSubtotal ? { background: "var(--cr-surface-2)" } : undefined}>
                  <td style={f.esSubtotal ? { fontWeight: 600 } : undefined}>{f.etiqueta}</td>
                  <td className="num">{fmtUnidades(f.pedidas)}</td>
                  <td className="num">{fmtUnidades(f.entregadas)}</td>
                  <td className="num">{fmtPct(f.fillRate)}</td>
                  <td>
                    {f.fillRate !== null ? (
                      <Meter
                        value={f.fillRate}
                        tono={f.fillRate >= 0.95 ? "ok" : f.fillRate >= 0.8 ? "warn" : "danger"}
                      />
                    ) : null}
                  </td>
                </tr>
              )
            )}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div className="cr-table-scroll">
      <table className="cr-table">
        <thead>
          <tr>
            <th>Etiqueta</th>
            <th className="num">Unidades año anterior</th>
            <th className="num">Unidades año actual</th>
            <th className="num">Inventario</th>
            <th className="num">Inc vs AA</th>
            <th className="num">MOH</th>
          </tr>
        </thead>
        <tbody>
          {bloque.filas.map((f, i) => (
            <tr key={i} style={f.esSubtotal ? { background: "var(--cr-surface-2)" } : undefined}>
              <td style={f.esSubtotal ? { fontWeight: 600 } : undefined}>{f.etiqueta}</td>
              <td className="num">{fmtUnidades(f.unidadesAnterior)}</td>
              <td className="num">{fmtUnidades(f.unidadesActual)}</td>
              <td className="num">{fmtUnidades(f.inventario)}</td>
              <td
                className="num"
                style={
                  f.incVsAA !== null
                    ? { color: f.incVsAA >= 0 ? "var(--cr-ok)" : "var(--cr-danger)" }
                    : undefined
                }
              >
                {fmtPct(f.incVsAA)}
              </td>
              <td className="num">{fmtMoh(f.moh)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default async function ScorecardPage({
  params,
}: {
  params: Promise<{ uploadId: string }>;
}) {
  const usuario = await getSessionUser();
  if (!usuario) redirect("/login");
  if (!canAccess(usuario, "retail")) return <AccesoDenegado modulo="Retail" />;

  const { uploadId } = await params;
  if (!isValidObjectId(uploadId)) notFound();
  await connectDB();
  const carga = await Upload.findById(uploadId).lean();
  if (!carga) notFound();

  const scorecard = await generarScorecard(carga.account, fechaISO(new Date(carga.cutoffDate)));

  return (
    <>
      <PageHeader
        title={`Scorecard — ${scorecard.cuentaNombre}`}
        description={`Generado desde el histórico persistido, hasta el corte ${scorecard.ultimoCorte ?? "—"}`}
      />
      <div className="cr-page-content flex max-w-5xl flex-col gap-6">
        <Panel title="Cobertura de datos">
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <div className="cr-field">
              <span className="cr-label">Rango cargado</span>
              <span className="cr-mono">
                {scorecard.coverage.desde ?? "—"} → {scorecard.coverage.hasta ?? "—"}
              </span>
            </div>
            <div className="cr-field">
              <span className="cr-label">Cortes</span>
              <span className="cr-mono">{fmtNum(scorecard.coverage.cortes.length)}</span>
            </div>
            <div className="cr-field">
              <span className="cr-label">Meses completos</span>
              <span className="cr-body">
                {scorecard.coverage.mesesCompletos.join(", ") || "—"}
              </span>
            </div>
            <div className="cr-field">
              <span className="cr-label">Meses parciales</span>
              <span className="cr-body">
                {scorecard.coverage.mesesParciales.join(", ") || "—"}
              </span>
            </div>
          </div>
        </Panel>

        {scorecard.bloques.length === 0 ? (
          <Panel>
            <p className="cr-body py-8 text-center">
              Aún no hay cargas procesadas para esta account: el scorecard se genera del
              histórico en MongoDB.
            </p>
          </Panel>
        ) : (
          scorecard.bloques.map((b) => (
            <Panel
              key={b.id}
              title={
                <span className="flex items-center gap-2">
                  {b.title}
                  {b.sinHistorico ? <Badge tono="warn">Sin histórico comparable</Badge> : null}
                </span>
              }
              sinPadding
            >
              <p className="cr-body border-b px-4 py-3" style={{ borderColor: "var(--cr-line-soft)" }}>
                {b.narrativa}
              </p>
              <TablaBloque bloque={b} />
            </Panel>
          ))
        )}
      </div>
    </>
  );
}
