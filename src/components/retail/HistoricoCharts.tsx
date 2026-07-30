"use client";

import { useCallback, useEffect, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { api, ClientApiError } from "@/components/lib/api-client";
import { Panel } from "@/components/ui/basicos";

// Colores del design system: tinta para las series, ok/danger para
// estados. Nada de morado fuera de Cronos IA (§10).
const INK = "#15171c";
const OK = "#1f9468";
const DANGER = "#cf4733";
const GRID = "rgba(10,12,18,0.06)";
const LABEL = "#99a0ab";

interface Serie {
  ventasPorSemana: Array<{ semana: string; unidades: number }>;
  inventarioPorCorte: Array<{ corte: string; inventario: number; moh: number | null }>;
  fillRatePorCorte: Array<{ corte: string; fillRate: number | null }>;
}

const ejes = {
  tick: { fontSize: 10, fill: LABEL, fontFamily: "var(--cr-font-mono)" },
  stroke: GRID,
};

export function HistoricoCharts() {
  const [serie, setSerie] = useState<Serie | null>(null);
  const [desde, setDesde] = useState("");
  const [hasta, setHasta] = useState("");
  const [error, setError] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    setError(null);
    try {
      const q = new URLSearchParams({ cuenta: "san-pablo" });
      if (desde) q.set("desde", desde);
      if (hasta) q.set("hasta", hasta);
      setSerie(await api<Serie>(`/api/retail/historico?${q.toString()}`));
    } catch (e) {
      setError(e instanceof ClientApiError ? e.message : "No se pudo cargar la serie");
    }
  }, [desde, hasta]);

  useEffect(() => {
    // fetch-on-mount: el flag de carga se activa al iniciar la petición
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void cargar();
  }, [cargar]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="cr-field">
          <span className="cr-label">Desde</span>
          <input type="date" className="cr-input" value={desde} onChange={(e) => setDesde(e.target.value)} />
        </label>
        <label className="cr-field">
          <span className="cr-label">Hasta</span>
          <input type="date" className="cr-input" value={hasta} onChange={(e) => setHasta(e.target.value)} />
        </label>
        <label className="cr-field">
          <span className="cr-label">Cuenta</span>
          <select className="cr-input w-auto" defaultValue="san-pablo">
            <option value="san-pablo">San Pablo</option>
          </select>
        </label>
      </div>

      {error ? (
        <p className="cr-small" style={{ color: "var(--cr-danger)" }} role="alert">
          {error}
        </p>
      ) : null}

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <Panel titulo="Venta por semana (unidades)">
          <div style={{ height: 260 }}>
            <ResponsiveContainer>
              <LineChart data={serie?.ventasPorSemana ?? []}>
                <CartesianGrid stroke={GRID} vertical={false} />
                <XAxis dataKey="semana" {...ejes} />
                <YAxis {...ejes} width={48} />
                <Tooltip contentStyle={{ fontSize: 12, borderRadius: 2 }} />
                <Line type="monotone" dataKey="unidades" stroke={INK} strokeWidth={1.75} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Panel>

        <Panel titulo="Fill rate por corte">
          <div style={{ height: 260 }}>
            <ResponsiveContainer>
              <LineChart data={serie?.fillRatePorCorte ?? []}>
                <CartesianGrid stroke={GRID} vertical={false} />
                <XAxis dataKey="corte" {...ejes} />
                <YAxis
                  {...ejes}
                  width={48}
                  domain={[0, 1]}
                  tickFormatter={(v: number) => `${Math.round(v * 100)}%`}
                />
                <Tooltip
                  contentStyle={{ fontSize: 12, borderRadius: 2 }}
                  formatter={(v) => `${((v as number) * 100).toFixed(1)}%`}
                />
                <Line type="monotone" dataKey="fillRate" stroke={OK} strokeWidth={1.75} dot />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Panel>

        <Panel titulo="Evolución de inventario">
          <div style={{ height: 260 }}>
            <ResponsiveContainer>
              <LineChart data={serie?.inventarioPorCorte ?? []}>
                <CartesianGrid stroke={GRID} vertical={false} />
                <XAxis dataKey="corte" {...ejes} />
                <YAxis {...ejes} width={56} />
                <Tooltip contentStyle={{ fontSize: 12, borderRadius: 2 }} />
                <Line type="monotone" dataKey="inventario" stroke={INK} strokeWidth={1.75} dot />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Panel>

        <Panel titulo="MOH por corte (meses de inventario)">
          <div style={{ height: 260 }}>
            <ResponsiveContainer>
              <LineChart data={serie?.inventarioPorCorte ?? []}>
                <CartesianGrid stroke={GRID} vertical={false} />
                <XAxis dataKey="corte" {...ejes} />
                <YAxis {...ejes} width={48} />
                <Tooltip contentStyle={{ fontSize: 12, borderRadius: 2 }} />
                <Line type="monotone" dataKey="moh" stroke={DANGER} strokeWidth={1.75} dot />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Panel>
      </div>
    </div>
  );
}
