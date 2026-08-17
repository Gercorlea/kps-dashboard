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
    // lg y no xl: el contenido vive dentro del shell con la barra lateral de
    // 240px, así que el ancho útil no llega a 1280 y los cuatro KPIs se partían
    // en dos filas incluso en pantallas grandes.
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <Kpi label={`Total ${nombreMetrica}`} value={formatearCompacto(kpis.totalMetrica)} />
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
