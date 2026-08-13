import { memo } from "react";
import { Kpi } from "@/components/ui/basicos";
import {
  formatearCompacto,
  formatearEntero,
  formatearFecha,
} from "@/lib/retail/analisis/formato";
import type { Kpis } from "@/lib/retail/analisis/tipos";

interface Props {
  kpis: Kpis;
  nombreMetrica: string;
  nombreDimension: string | null;
}

function AnalisisKpisBase({ kpis, nombreMetrica, nombreDimension }: Props) {
  const { rangoFechas } = kpis;

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <Kpi label={`Total ${nombreMetrica}`} value={formatearCompacto(kpis.totalMetrica)} />
      <Kpi label="Filas cargadas" value={formatearEntero(kpis.totalFilas)} />
      {nombreDimension ? (
        <Kpi
          label={`${nombreDimension} distintos`}
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
