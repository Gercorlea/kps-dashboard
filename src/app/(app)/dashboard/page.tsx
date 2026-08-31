import type { CSSProperties } from "react";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { fmtFecha, fmtNum, fmtPct } from "@/components/lib/fmt";
import { Kpi, Meter, Panel } from "@/components/ui/basicos";
import { getSessionUser } from "@/lib/auth/guards";
import { formatearMoneda, formatearMonedaCompacta } from "@/lib/retail/analisis/formato";
import { colorRetailer } from "@/lib/retail/retailers";
import { detalleRetailers } from "@/lib/retail/stats";

// Portada general: no repite las cards ni la gráfica en unidades/12 meses de
// /retail —eso habla de cuánto se movió recientemente—, sino un ranking en
// dinero, histórico completo, de quién vende más. Cuando se sume Proveedores,
// este mismo criterio de ranking se replica para ese dominio en vez de traer
// aquí su propio resumen de unidades.
//
// Solo cuatro retailers y seis columnas cortas: a lo ancho de la pantalla la
// tabla por defecto de .cr-table (13px, 12px·14px de padding) se ve dispersa,
// con mucho hueco entre columnas. En vez de encoger la tabla, se agranda la
// letra y el padding de esta tabla en particular —sin tocar design-system.css,
// que comparten tablas con muchas más columnas.
const ENCABEZADO: CSSProperties = { padding: "16px 20px", fontSize: 12 };
const CELDA: CSSProperties = { padding: "18px 20px", fontSize: 14 };

export default async function DashboardPage() {
  const usuario = await getSessionUser();
  if (!usuario) redirect("/login");

  const retailers = await detalleRetailers();
  const ranking = [...retailers].sort((a, b) => b.importe - a.importe);

  const ventasTotales = ranking.reduce((t, r) => t + r.importe, 0);
  const articulosTotales = ranking.reduce((t, r) => t + r.articulos, 0);
  const lider = ventasTotales > 0 ? ranking[0] : null;

  return (
    <>
      <PageHeader title="Dashboard" description="Resumen Operativo de KPS" />
      <div className="cr-page-content cr-page-content--pegado flex flex-col gap-6">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Kpi
            label="Ventas totales"
            value={formatearMonedaCompacta(ventasTotales)}
            detalle="Histórico completo · todos los retailers"
          />
          <Kpi
            label="Retailer líder"
            value={lider ? lider.nombre : "—"}
            positivo={lider !== null}
            detalle={lider ? `${fmtPct(lider.participacion)} de participación` : "Sin ventas registradas"}
          />
          <Kpi
            label="Productos en catálogo"
            value={fmtNum(articulosTotales)}
            detalle="Productos distintos vendidos, todos los retailers"
          />
        </div>

        <div style={{ width: "85%", margin: "0 auto" }}>
          <Panel title="Ranking de ventas por retailer" sinPadding>
            <div className="cr-table-scroll">
              <table className="cr-table">
                <thead>
                  <tr>
                    <th style={ENCABEZADO}>#</th>
                    <th style={ENCABEZADO}>Retailer</th>
                    <th className="num" style={ENCABEZADO}>Ventas</th>
                    <th style={ENCABEZADO}>Participación</th>
                    <th className="num" style={ENCABEZADO}>Productos</th>
                    <th style={ENCABEZADO}>Último reporte</th>
                  </tr>
                </thead>
                <tbody>
                  {ranking.map((r, i) => (
                    <tr key={r.id}>
                      <td className="cr-mono" style={CELDA}>{i + 1}</td>
                      <td style={CELDA}>
                        <div className="flex items-center gap-3">
                          <span
                            aria-hidden="true"
                            className="size-3.5 shrink-0"
                            style={{
                              background: colorRetailer(r.id),
                              borderRadius: "var(--cr-r-xs)",
                            }}
                          />
                          <span style={{ fontSize: 15 }}>{r.nombre}</span>
                        </div>
                      </td>
                      <td className="num" style={{ ...CELDA, fontSize: 15 }}>
                        {formatearMoneda(r.importe)}
                      </td>
                      <td style={CELDA}>
                        <div className="flex items-center gap-3">
                          <div className="w-40">
                            <Meter value={r.participacion ?? 0} />
                          </div>
                          <span className="cr-mono" style={{ fontSize: 13 }}>
                            {fmtPct(r.participacion)}
                          </span>
                        </div>
                      </td>
                      <td className="num" style={CELDA}>{fmtNum(r.articulos)}</td>
                      <td className="cr-mono" style={CELDA}>{fmtFecha(r.ultimoReporte)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        </div>
      </div>
    </>
  );
}
