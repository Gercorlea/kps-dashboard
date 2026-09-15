import { redirect } from "next/navigation";
import Link from "next/link";
import { VentasNetasChart } from "@/components/dashboard/VentasNetasChart";
import { Pagina } from "@/components/dashboard/Pagina";
import { fmtFecha, fmtNum, fmtPct } from "@/components/lib/fmt";
import { Kpi, Meter, Panel, Tabla } from "@/components/ui/basicos";
import { getSessionUser } from "@/lib/auth/guards";
import { formatearMoneda, formatearMonedaCompacta } from "@/lib/retail/analisis/formato";
import { detalleRetailers, ventasNetasMensuales } from "@/lib/retail/stats";

// Portada general: no repite las cards ni la gráfica en unidades/12 meses de
// /retail —eso habla de cuánto se movió recientemente—, sino un ranking en
// dinero, histórico completo, de quién vende más. Cuando se sume Proveedores,
// este mismo criterio de ranking se replica para ese dominio en vez de traer
// aquí su propio resumen de unidades.
//
export default async function DashboardPage() {
  const usuario = await getSessionUser();
  if (!usuario) redirect("/login");

  // Las dos consultas son independientes: van en paralelo. La de la gráfica no
  // agrega latencia — lo caro de detalleRetailers son sus dos $addToSet sobre
  // los itemNbr distintos, y la de ventas netas es un $sum a secas.
  const [retailers, ventasNetas] = await Promise.all([
    detalleRetailers(),
    ventasNetasMensuales(),
  ]);
  const ranking = [...retailers].sort((a, b) => b.importe - a.importe);

  const ventasTotales = ranking.reduce((t, r) => t + r.importe, 0);
  const articulosTotales = ranking.reduce((t, r) => t + r.articulos, 0);
  const lider = ventasTotales > 0 ? ranking[0] : null;

  // El ranking suma TODO el histórico, y sin decirlo se lee como si fuera del
  // año en curso: Walmart es el 94.5% acumulado desde mayo de 2024 pero el
  // 85.3% de 2026, porque San Pablo sólo reporta desde 2026. Dos cifras
  // correctas que se contradicen si nadie nombra el periodo.
  const desde = ranking.map((r) => r.desde).filter((d): d is string => d !== null).sort()[0] ?? null;
  const hasta = ranking.map((r) => r.hasta).filter((d): d is string => d !== null).sort().at(-1) ?? null;
  const periodo = desde && hasta ? `Acumulado ${fmtFecha(desde)} – ${fmtFecha(hasta)}` : "Acumulado histórico";

  return (
    <Pagina title="Dashboard" description="Resumen operativo de KPS">
      <div className="cr-dashboard">
        <section className="cr-dashboard__indicadores" aria-label="Indicadores de ventas">
          <Kpi
            label="Ventas totales"
            value={formatearMonedaCompacta(ventasTotales)}
            detalle="Histórico completo · todos los retailers"
          />
          <Kpi
            label="Retailer líder"
            value={lider ? lider.nombre : "—"}
            detalle={lider ? `${fmtPct(lider.participacion)} de participación` : "Sin ventas registradas"}
          />
          <Kpi
            label="Productos en catálogo"
            value={fmtNum(articulosTotales)}
            detalle="Productos distintos vendidos, todos los retailers"
          />
        </section>

        {/* La evolución antes del ranking: primero cómo va el año, después
            quién lo compone. El panel dice su año y el ranking dice su
            periodo, porque son dos ventanas distintas de lo mismo. */}
        <VentasNetasChart datos={ventasNetas} />

        <Panel
          title="Ranking de ventas por retailer"
          subtitulo={periodo}
          acciones={
            <Link href="/retail" className="cr-btn cr-btn--secondary cr-btn--sm">
              Ver retailers
            </Link>
          }
          sinPadding
        >
          <Tabla fija>
              <colgroup>
                <col className="cr-dashboard__rango" />
                <col />
                <col className="cr-dashboard__ventas" />
                <col className="cr-dashboard__participacion" />
                <col className="cr-dashboard__productos" />
                <col className="cr-dashboard__fecha" />
              </colgroup>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Retailer</th>
                  <th className="num">Ventas</th>
                  <th>Participación</th>
                  <th className="num">Productos</th>
                  <th>Última venta</th>
                </tr>
              </thead>
              <tbody>
                {ranking.map((r, i) => (
                  <tr key={r.id}>
                    <td className="cr-mono">{i + 1}</td>
                    <td><span className="cr-dashboard__nombre" title={r.nombre}>{r.nombre}</span></td>
                    <td className="num">{formatearMoneda(r.importe)}</td>
                    <td>
                      <div className="cr-dashboard__meter">
                        <div className="cr-dashboard__meter-barra">
                          <Meter value={r.participacion ?? 0} tono="ink" />
                        </div>
                        <span className="cr-mono">{fmtPct(r.participacion)}</span>
                      </div>
                    </td>
                    <td className="num">{fmtNum(r.articulos)}</td>
                    <td
                      className="cr-mono"
                      title={
                        r.ultimoReporte
                          ? `Último archivo cargado el ${fmtFecha(r.ultimoReporte)}${r.ultimoArchivo ? `: ${r.ultimoArchivo}` : ""}`
                          : undefined
                      }
                    >
                      {fmtFecha(r.hasta)}
                    </td>
                  </tr>
                ))}
              </tbody>
          </Tabla>
        </Panel>
      </div>
    </Pagina>
  );
}
