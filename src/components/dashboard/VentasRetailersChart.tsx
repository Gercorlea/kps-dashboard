"use client";

// Gráfica general del dashboard: una línea por retailer con la venta mensual
// en unidades. No calcula nada — recibe la serie ya agregada por
// lib/retail/stats.ts, que es quien sabe de qué colección sale cada venta.
//
// El cromo (ejes, tooltip, leyenda) sale de components/retail/viz.tsx, el mismo
// que usan las gráficas de la ficha del retailer: las dos rutas tienen que
// verse iguales.

import { useState } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { fmtMes, fmtMesLargo, fmtNum } from "@/components/lib/fmt";
import {
  CajaTooltip,
  CURSOR_LINEA,
  DegradadoArea,
  ejeValor,
  Leyenda,
  VIZ_ANIM,
  VIZ_GRID,
  VIZ_SUPERFICIE,
  type FilaViz,
} from "@/components/retail/viz";
import { formatearEje } from "@/lib/retail/analisis/formato";
import { colorRetailer } from "@/lib/retail/retailers";
import type { PuntoVentas, VentasRetailer } from "@/lib/retail/stats";

/** Id del degradado de cada retailer; uno por serie, con el color de la cuenta. */
function idArea(id: string): string {
  return `cr-area-retailer-${id}`;
}

export function VentasRetailersChart({
  serie,
  retailers,
}: {
  serie: PuntoVentas[];
  retailers: VentasRetailer[];
}) {
  // Serie aislada. Se fija con clic y se asoma con el puntero: con cuatro
  // líneas cruzándose, seguir una sola es la lectura que más se pide y la que
  // la leyenda sola no resuelve.
  const [fijo, setFijo] = useState<string | null>(null);
  const [asomado, setAsomado] = useState<string | null>(null);
  const foco = asomado ?? fijo;

  if (retailers.every((r) => r.unidades === 0)) {
    return (
      <p className="cr-body py-12 text-center">
        Todavía no hay ventas registradas. Sube el reporte de un retailer para ver la
        comparativa.
      </p>
    );
  }

  const leyenda: FilaViz[] = retailers.map((r) => ({
    clave: r.id,
    etiqueta: r.nombre,
    color: colorRetailer(r.id),
    valor: r.unidades > 0 ? fmtNum(r.unidades) : "sin datos",
    // Aislar una cuenta sin ventas dejaría la gráfica en blanco: su ítem se
    // queda como texto.
    inerte: r.unidades === 0,
  }));

  return (
    <>
      <div style={{ height: 300 }}>
        <ResponsiveContainer debounce={50}>
          <ComposedChart data={serie} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
            <defs>
              {retailers.map((r) => (
                <DegradadoArea key={r.id} id={idArea(r.id)} color={colorRetailer(r.id)} />
              ))}
            </defs>
            <CartesianGrid stroke={VIZ_GRID} vertical={false} />
            <XAxis dataKey="periodo" tickFormatter={fmtMes} {...ejeValor} />
            <YAxis tickFormatter={formatearEje} width={56} {...ejeValor} />
            <Tooltip
              cursor={CURSOR_LINEA}
              // Las filas se arman desde el punto de datos y en el orden de
              // RETAILERS, no desde el payload de recharts: así el tooltip y la
              // leyenda enumeran las cuentas igual.
              content={({ active, label, payload }) => {
                if (!active) return null;
                const punto = payload?.[0]?.payload as Record<string, number> | undefined;
                if (!punto) return null;
                const filas = retailers
                  .filter((r) => typeof punto[r.id] === "number")
                  .map((r) => ({
                    clave: r.id,
                    etiqueta: r.nombre,
                    color: colorRetailer(r.id),
                    valor: fmtNum(punto[r.id]),
                  }))
                  .sort((a, b) => punto[b.clave] - punto[a.clave]);
                const total = filas.reduce((s, f) => s + punto[f.clave], 0);
                return (
                  <CajaTooltip
                    titulo={fmtMesLargo(String(label))}
                    filas={filas}
                    total={
                      filas.length > 1
                        ? { clave: "total", etiqueta: "Total", valor: fmtNum(total) }
                        : undefined
                    }
                  />
                );
              }}
            />
            {/* El relleno solo se pinta bajo la serie aislada: cuatro lavados
                superpuestos son una mancha, uno solo enseña el volumen. */}
            {retailers.map((r) => (
              <Area
                key={`area-${r.id}`}
                type="monotone"
                dataKey={r.id}
                stroke="none"
                fill={`url(#${idArea(r.id)})`}
                fillOpacity={foco === r.id ? 1 : 0}
                connectNulls={false}
                isAnimationActive={false}
                activeDot={false}
              />
            ))}
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
                strokeWidth={foco === r.id ? 2.5 : 2}
                strokeOpacity={foco === null || foco === r.id ? 1 : 0.16}
                strokeLinecap="round"
                strokeLinejoin="round"
                dot={false}
                // El anillo del color de la superficie separa el punto de la
                // línea que cruza por debajo; no es un borde, es aire.
                activeDot={{ r: 4, strokeWidth: 2, stroke: VIZ_SUPERFICIE }}
                connectNulls={false}
                animationDuration={VIZ_ANIM}
              />
            ))}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <Leyenda items={leyenda} foco={foco} onFijar={setFijo} onAsomar={setAsomado} />
    </>
  );
}
