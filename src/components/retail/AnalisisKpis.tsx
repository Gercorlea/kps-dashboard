import { memo } from "react";
import { Kpi } from "@/components/ui/basicos";
import {
  formatearCompacto,
  formatearEntero,
  formatearFecha,
  formatearMonedaCompacta,
  formatearPorcentajeConSigno,
} from "@/lib/retail/analisis/formato";
import type { Kpis } from "@/lib/retail/analisis/tipos";

/**
 * Los dos KPIs de la derecha en la ficha de un retailer: cómo va el año contra
 * el anterior y cuánto vale un mes típico.
 *
 * Son datos de DESEMPEÑO, y por eso no los pinta el analizador de Excel: ahí lo
 * que se está mirando es un archivo recién subido, y lo que importa de él es
 * cuántas filas trae y qué periodo cubre. Sin esta prop se muestran esos dos.
 */
export interface EvolucionKpis {
  /** Comparativa anual; null cuando sólo hay un año cargado. */
  anual: {
    anioActual: number;
    anioPrevio: number;
    /** Null si el año previo no da una base positiva sobre la que comparar. */
    variacion: number | null;
    mesesComparables: number;
  } | null;
  /**
   * Métrica por mes del tramo que se esté mirando; null si no hay serie.
   *
   * Sin filtro de fechas el tramo es el ÚLTIMO año con datos y `anio` dice
   * cuál: `meses` son los que ese año trae en el reporte, que hasta diciembre
   * no son doce. Con filtro el tramo es el periodo elegido y `anio` va en null,
   * porque un rango puede cruzar dos años y "de 2026" sería mentira.
   */
  promedioMensual: { valor: number; meses: number; anio: number | null } | null;
}

interface Props {
  kpis: Kpis;
  nombreMetrica: string;
  nombreDimension: string | null;
  /**
   * La métrica es un importe. Va junto con la misma prop de AnalisisCharts: en
   * la pestaña Overview el KPI y la gráfica muestran el MISMO total, así que uno
   * con "$" y el otro sin él se leería como un descuadre.
   */
  metricaMoneda?: boolean;
  /** Ver EvolucionKpis: presente sólo en la ficha de un retailer. */
  evolucion?: EvolucionKpis;
  /**
   * Rango con datos del periodo filtrado; ausente cuando no hay filtro.
   *
   * Los KPIs van por ENCIMA del selector de fechas, así que sin esta línea la
   * cifra del total no dice sobre qué está calculada y se lee como el histórico
   * completo. Son las fechas con ventas dentro del rango, no las escritas en
   * los inputs: es lo que de verdad hay detrás del número.
   */
  periodo?: { desde: Date; hasta: Date };
}

/**
 * KPI de la variación anual. El porcentaje va con el color del signo —y no en
 * el badge de la gráfica, que a 10.5px se perdería en una tarjeta de 30px— y el
 * detalle dice contra qué se está comparando, que sin años a la vista es lo
 * único que hace interpretable el número.
 */
function KpiAnual({ anual }: { anual: EvolucionKpis["anual"] }) {
  if (!anual) {
    return (
      <Kpi
        label="vs. año anterior"
        value="—"
        detalle="Sólo hay un año cargado"
      />
    );
  }

  if (anual.variacion === null || anual.mesesComparables === 0) {
    return (
      <Kpi
        label="vs. año anterior"
        value="—"
        detalle={
          anual.mesesComparables === 0
            ? `${anual.anioActual} y ${anual.anioPrevio} no comparten ningún mes`
            : `${anual.anioPrevio} no deja una base con la que comparar`
        }
      />
    );
  }

  const color =
    anual.variacion > 0
      ? "var(--cr-ok)"
      : anual.variacion < 0
        ? "var(--cr-danger)"
        : undefined;

  return (
    <Kpi
      label="vs. año anterior"
      value={<span style={{ color }}>{formatearPorcentajeConSigno(anual.variacion)}</span>}
      // Los meses comparables no son decoración: la cifra sale SÓLO de los
      // meses que están en los dos años, así que un año a medias compara
      // medio año y conviene que se vea.
      detalle={`${anual.anioActual} vs ${anual.anioPrevio} · ${anual.mesesComparables} ${
        anual.mesesComparables === 1 ? "mes" : "meses"
      }`}
    />
  );
}

function AnalisisKpisBase({
  kpis,
  nombreMetrica,
  nombreDimension,
  metricaMoneda = false,
  evolucion,
  periodo,
}: Props) {
  const { rangoFechas } = kpis;
  const fmtTotal = metricaMoneda ? formatearMonedaCompacta : formatearCompacto;

  return (
    // lg y no xl: el contenido vive dentro del shell con la barra lateral de
    // 240px, así que el ancho útil no llega a 1280 y los cuatro KPIs se partían
    // en dos filas incluso en pantallas grandes.
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {/* Primero las tres lecturas de la métrica —cuánto, cómo va contra el año
          pasado y cuánto vale un mes— y al final el recuento de la dimensión,
          que es lo único que no habla de la métrica. */}
      <Kpi
        label={`Total ${nombreMetrica}`}
        value={fmtTotal(kpis.totalMetrica)}
        detalle={
          periodo ? (
            <span className="cr-mono">
              {formatearFecha(periodo.desde)} → {formatearFecha(periodo.hasta)}
            </span>
          ) : undefined
        }
      />

      {evolucion ? (
        <>
          <KpiAnual anual={evolucion.anual} />
          {evolucion.promedioMensual ? (
            <Kpi
              label="Promedio mensual"
              value={fmtTotal(evolucion.promedioMensual.valor)}
              // Se dice sobre cuántos meses —y de qué— está calculado: el
              // promedio de un año a medias no se compara con el de uno
              // completo, y sin esta línea no habría forma de saberlo. Con
              // filtro puesto el tramo es el periodo y no un año (ver
              // EvolucionKpis).
              detalle={`${evolucion.promedioMensual.meses} ${
                evolucion.promedioMensual.meses === 1 ? "mes" : "meses"
              } ${
                evolucion.promedioMensual.anio !== null
                  ? `de ${evolucion.promedioMensual.anio}`
                  : "del periodo"
              }`}
            />
          ) : null}
        </>
      ) : (
        <>
          <Kpi label="Filas cargadas" value={formatearEntero(kpis.totalFilas)} />
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
        </>
      )}

      {nombreDimension ? (
        <Kpi
          // Entre paréntesis y no "… distintos": ahora que las dimensiones se
          // llaman en español ("Marca", "Nombre del producto"), concordar el
          // adjetivo exigiría saber género y número de cada etiqueta.
          label={`${nombreDimension} (distintos)`}
          value={formatearEntero(kpis.dimensionesDistintas)}
        />
      ) : null}
    </div>
  );
}

export const AnalisisKpis = memo(AnalisisKpisBase);
