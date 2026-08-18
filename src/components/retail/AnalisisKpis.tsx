import { memo } from "react";
import { Kpi } from "@/components/ui/basicos";
import {
  formatearCompacto,
  formatearEntero,
  formatearFecha,
  formatearMonedaCompacta,
} from "@/lib/retail/analisis/formato";
import type { Kpis } from "@/lib/retail/analisis/tipos";

interface Props {
  kpis: Kpis;
  nombreMetrica: string;
  nombreDimension: string | null;
  /**
   * La métrica es un importe. Va junto con la misma prop de AnalisisCharts: en
   * la pestaña Resumen el KPI y la gráfica muestran el MISMO total, así que uno
   * con "$" y el otro sin él se leería como un descuadre.
   */
  metricaMoneda?: boolean;
}

function AnalisisKpisBase({
  kpis,
  nombreMetrica,
  nombreDimension,
  metricaMoneda = false,
}: Props) {
  const { rangoFechas } = kpis;
  const fmtTotal = metricaMoneda ? formatearMonedaCompacta : formatearCompacto;

  return (
    // lg y no xl: el contenido vive dentro del shell con la barra lateral de
    // 240px, así que el ancho útil no llega a 1280 y los cuatro KPIs se partían
    // en dos filas incluso en pantallas grandes.
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <Kpi label={`Total ${nombreMetrica}`} value={fmtTotal(kpis.totalMetrica)} />
      <Kpi label="Filas cargadas" value={formatearEntero(kpis.totalFilas)} />
      {nombreDimension ? (
        <Kpi
          // Entre paréntesis y no "… distintos": ahora que las dimensiones se
          // llaman en español ("Marca", "Nombre del producto"), concordar el
          // adjetivo exigiría saber género y número de cada etiqueta.
          label={`${nombreDimension} (distintos)`}
          value={formatearEntero(kpis.dimensionesDistintas)}
        />
      ) : null}
      {rangoFechas ? (
        <Kpi
          label="Rango de fechas"
          value={
            <span className="cr-mono" style={{ fontSize: "15px" }}>
              {formatearFecha(rangoFechas.desde)} → {formatearFecha(rangoFechas.hasta)}
            </span>
          }
        />
      ) : null}
    </div>
  );
}

export const AnalisisKpis = memo(AnalisisKpisBase);
