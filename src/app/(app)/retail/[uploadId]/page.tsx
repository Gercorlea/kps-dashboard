import { isValidObjectId } from "mongoose";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { AccesoDenegado } from "@/components/dashboard/AccesoDenegado";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { SheetTable } from "@/components/retail/SheetTable";
import { Badge, Kpi, Panel } from "@/components/ui/basicos";
import { fmtNum } from "@/components/lib/fmt";
import { getSessionUser } from "@/lib/auth/guards";
import { connectDB } from "@/lib/db";
import { canAccess } from "@/lib/rbac";
import { fechaISO } from "@/lib/retail/normalize";
import { Upload, type IResumenHoja } from "@/models/Upload";

const TONO_STATUS: Record<string, "ok" | "warn" | "danger" | "neutro"> = {
  procesado: "ok",
  procesando: "warn",
  pendiente: "neutro",
  error: "danger",
};

export default async function DetalleCargaPage({
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

  const resumen = (carga.resumen ?? {}) as Record<string, IResumenHoja>;
  const totalInsertadas = Object.values(resumen).reduce((t, r) => t + (r?.insertadas ?? 0), 0);
  const totalLeidas = Object.values(resumen).reduce((t, r) => t + (r?.leidas ?? 0), 0);
  const totalRechazadas = Object.values(resumen).reduce((t, r) => t + (r?.rechazadas ?? 0), 0);
  const incidencias = carga.incidencias ?? [];
  const marcasSinClasificar = incidencias.filter((i) => i.campo === "marca");

  return (
    <>
      <PageHeader
        titulo={carga.filename}
        descripcion={`Corte ${fechaISO(new Date(carga.fechaCorte))} · cuenta San Pablo`}
        acciones={
          <>
            <Badge tono={TONO_STATUS[carga.status] ?? "neutro"}>{carga.status}</Badge>
            <Link href={`/retail/${uploadId}/scorecard`} className="cr-btn cr-btn--primary">
              Ver scorecard
            </Link>
          </>
        }
      />
      <div className="cr-page-content flex flex-col gap-6">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Kpi label="Filas leídas" value={fmtNum(totalLeidas)} />
          <Kpi label="Documentos insertados" value={fmtNum(totalInsertadas)} />
          <Kpi
            label="Filas rechazadas"
            value={fmtNum(totalRechazadas)}
            alerta={totalRechazadas > 0}
          />
          <Kpi
            label="Incidencias"
            value={fmtNum(incidencias.length)}
            alerta={marcasSinClasificar.length > 0}
            detalle={
              marcasSinClasificar.length > 0 ? (
                <Badge tono="warn">{marcasSinClasificar.length} marcas sin clasificar</Badge>
              ) : undefined
            }
          />
        </div>

        {incidencias.length > 0 ? (
          <Panel titulo="Incidencias de la carga">
            <ul className="cr-small flex list-inside list-disc flex-col gap-1">
              {incidencias.slice(0, 30).map((i, idx) => (
                <li key={idx}>
                  <span className="cr-mono">[{i.hoja}
                  {i.fila ? ` · fila ${i.fila}` : ""}]</span> {i.mensaje}
                </li>
              ))}
              {incidencias.length > 30 ? (
                <li>…y {incidencias.length - 30} más.</li>
              ) : null}
            </ul>
          </Panel>
        ) : null}

        {carga.status === "procesado" ? (
          <SheetTable uploadId={uploadId} hojas={carga.hojasDetectadas ?? []} />
        ) : (
          <Panel>
            <p className="cr-body py-6 text-center">
              La carga aún no está procesada. Las tablas por hoja aparecerán al terminar.
            </p>
          </Panel>
        )}
      </div>
    </>
  );
}
