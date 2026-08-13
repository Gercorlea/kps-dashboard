"use client";

import { useEffect, useState } from "react";
import { api, ClientApiError } from "@/components/lib/api-client";
import { fmtNum } from "@/components/lib/fmt";
import { Kpi, Panel } from "@/components/ui/basicos";

interface Stats {
  usuarios: { total: number; activos: number };
  cargas: { total: number; porStatus: Record<string, number> };
  filas: Record<string, number>;
  chats: { total: number; mensajes: number };
}

const ETIQUETAS_FILAS: Record<string, string> = {
  ventas: "Ventas diarias",
  pronosticos: "Pronósticos semanales",
  forecast: "Forecast diario",
  cedis: "Stock CEDIS",
  farmacia: "Stock farmacia",
  lineasOc: "Líneas de OC",
};

export function StatsAdmin() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Stats>("/api/admin/stats")
      .then(setStats)
      .catch((e) =>
        setError(e instanceof ClientApiError ? e.message : "No se pudieron cargar las estadísticas")
      );
  }, []);

  if (error) {
    return (
      <p className="cr-small" style={{ color: "var(--cr-danger)" }} role="alert">
        {error}
      </p>
    );
  }
  if (!stats) return <p className="cr-small">Cargando…</p>;

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi
          label="Usuarios"
          value={fmtNum(stats.usuarios.total)}
          detalle={`${fmtNum(stats.usuarios.activos)} activos`}
        />
        <Kpi
          label="Cargas"
          value={fmtNum(stats.cargas.total)}
          detalle={Object.entries(stats.cargas.porStatus)
            .map(([s, n]) => `${s}: ${n}`)
            .join(" · ")}
        />
        <Kpi
          label="Documentos retail"
          value={fmtNum(Object.values(stats.filas).reduce((t, n) => t + n, 0))}
        />
        <Kpi
          label="Chats de KPS AI"
          value={fmtNum(stats.chats.total)}
          detalle={`${fmtNum(stats.chats.mensajes)} mensajes`}
        />
      </div>

      <Panel title="Filas por colección" sinPadding>
        <div className="cr-table-scroll">
          <table className="cr-table">
            <thead>
              <tr>
                <th>Colección</th>
                <th className="num">Documentos</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(stats.filas).map(([k, n]) => (
                <tr key={k}>
                  <td>{ETIQUETAS_FILAS[k] ?? k}</td>
                  <td className="num">{fmtNum(n)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}
