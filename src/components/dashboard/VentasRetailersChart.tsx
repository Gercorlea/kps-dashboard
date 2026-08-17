"use client";

// Gráfica general del dashboard: una línea por retailer con la venta mensual
// en unidades. No calcula nada — recibe la serie ya agregada por
// lib/retail/stats.ts, que es quien sabe de qué colección sale cada venta.

import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { fmtMes, fmtMesLargo, fmtNum } from "@/components/lib/fmt";
import { formatearCompacto } from "@/lib/retail/analisis/formato";
import { colorRetailer } from "@/lib/retail/retailers";
import type { PuntoVentas, VentasRetailer } from "@/lib/retail/stats";

const GRID = "var(--cr-line-soft)";
const LABEL = "var(--cr-ink-3)";

// Mismos ejes que HistoricoCharts y AnalisisCharts: mono, 10px, tinta 3.
const ejes = {
  tick: { fontSize: 10, fill: LABEL, fontFamily: "var(--cr-font-mono)" },
  stroke: GRID,
};

/**
 * Leyenda en HTML plano y no el <Legend> de recharts: la versión 3 quitó la
 * prop `payload`, así que la librería ordena las series alfabéticamente y no
 * hay forma de fijar el orden (el mismo motivo que en AnalisisCharts).
 */
function Leyenda({ retailers }: { retailers: VentasRetailer[] }) {
  return (
    <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
      {retailers.map((r) => (
        <li key={r.id} className="flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="size-2.5 shrink-0"
            style={{ background: colorRetailer(r.id), borderRadius: "var(--cr-r-xs)" }}
          />
          <span className="cr-small" style={{ color: "var(--cr-ink-2)" }}>
            {r.nombre}
          </span>
          <span className="cr-mono cr-small">
            {r.unidades > 0 ? fmtNum(r.unidades) : "sin datos"}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function VentasRetailersChart({
  serie,
  retailers,
}: {
  serie: PuntoVentas[];
  retailers: VentasRetailer[];
}) {
  if (retailers.every((r) => r.unidades === 0)) {
    return (
      <p className="cr-body py-12 text-center">
        Todavía no hay ventas registradas. Sube el reporte de un retailer para ver la
        comparativa.
      </p>
    );
  }

  return (
    <>
      <div style={{ height: 300 }}>
        <ResponsiveContainer debounce={50}>
          <LineChart data={serie} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
            <CartesianGrid stroke={GRID} vertical={false} />
            <XAxis dataKey="periodo" tickFormatter={fmtMes} {...ejes} />
            <YAxis tickFormatter={formatearCompacto} width={56} {...ejes} />
            <Tooltip
              contentStyle={{ fontSize: 12, borderRadius: 2 }}
              labelFormatter={(v) => fmtMesLargo(String(v))}
              formatter={(v, nombre) => [fmtNum(Number(v)), nombre] as [string, typeof nombre]}
            />
            {/* Una línea por retailer, con o sin datos: la serie vacía no
                dibuja nada pero mantiene el color de cada cuenta fijo.
                `connectNulls` queda apagado a propósito — un mes sin reporte
                se corta, no se interpola. */}
            {retailers.map((r) => (
              <Line
                key={r.id}
                type="monotone"
                dataKey={r.id}
                name={r.nombre}
                stroke={colorRetailer(r.id)}
                strokeWidth={1.75}
                dot={{ r: 2.5 }}
                activeDot={{ r: 4 }}
                connectNulls={false}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <Leyenda retailers={retailers} />
    </>
  );
}
