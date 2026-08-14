"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Eye, FileSpreadsheet, Trash2 } from "lucide-react";
import { api, ClientApiError } from "@/components/lib/api-client";
import { fmtFechaHora, fmtNum } from "@/components/lib/fmt";
import { Badge } from "@/components/ui/basicos";
import { Paginacion } from "@/components/dashboard/Paginacion";

interface Carga {
  id: string;
  filename: string;
  account: string;
  cutoffDate: string;
  status: string;
  filas: number;
  issues: number;
  uploadedBy: string;
  createdAt: string;
}

const TONO: Record<string, "ok" | "warn" | "danger" | "neutro"> = {
  procesado: "ok",
  procesando: "warn",
  pendiente: "neutro",
  error: "danger",
};

export function CargasTable({ esSuperadmin }: { esSuperadmin: boolean }) {
  const router = useRouter();
  const [cargas, setCargas] = useState<Carga[]>([]);
  const [buscar, setBuscar] = useState("");
  const [account, setCuenta] = useState("san-pablo");
  const [pagina, setPagina] = useState(1);
  const [paginas, setPaginas] = useState(1);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(true);

  const cargar = useCallback(async () => {
    setCargando(true);
    setError(null);
    try {
      const q = new URLSearchParams({ page: String(pagina), account });
      if (buscar) q.set("buscar", buscar);
      const r = await api<{ cargas: Carga[]; total: number; paginas: number }>(
        `/api/retail/uploads?${q.toString()}`
      );
      setCargas(r.cargas);
      setTotal(r.total);
      setPaginas(r.paginas);
    } catch (e) {
      setError(e instanceof ClientApiError ? e.message : "No se pudieron cargar los datos");
    } finally {
      setCargando(false);
    }
  }, [pagina, account, buscar]);

  useEffect(() => {
    // fetch-on-mount: el flag de carga se activa al iniciar la petición
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void cargar();
  }, [cargar]);



  async function borrar(id: string, filename: string) {
    if (!window.confirm(`¿Borrar la carga "${filename}" y todas sus filas?`)) return;
    try {
      await api(`/api/retail/uploads/${id}`, { method: "DELETE" });
      void cargar();
      router.refresh();
    } catch (e) {
      setError(e instanceof ClientApiError ? e.message : "No se pudo borrar");
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <input
          className="cr-input max-w-xs"
          placeholder="Buscar por nombre de archivo…"
          value={buscar}
          onChange={(e) => {
            setBuscar(e.target.value);
            setPagina(1);
          }}
        />
        <select
          className="cr-input w-auto"
          value={account}
          onChange={(e) => setCuenta(e.target.value)}
          aria-label="Cuenta"
        >
          <option value="san-pablo">San Pablo</option>
        </select>
      </div>

      {error ? (
        <p className="cr-small" style={{ color: "var(--cr-danger)" }} role="alert">
          {error}
        </p>
      ) : null}

      <section className="cr-panel">
        <div className="cr-table-scroll">
          <table className="cr-table">
            <thead>
              <tr>
                <th>Archivo</th>
                <th>Fecha de corte</th>
                <th>Estatus</th>
                <th className="num">Filas</th>
                <th className="num">Incidencias</th>
                <th>Subido por</th>
                <th>Fecha</th>
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody>
              {cargando && cargas.length === 0 ? (
                <tr>
                  <td colSpan={8} className="cr-body py-10 text-center">
                    Cargando…
                  </td>
                </tr>
              ) : cargas.length === 0 ? (
                <tr>
                  <td colSpan={8} className="cr-body py-10 text-center">
                    Sin cargas todavía. Usa “Nueva carga” para subir el Excel semanal.
                  </td>
                </tr>
              ) : (
                cargas.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <span className="flex items-center gap-2">
                        <FileSpreadsheet
                          size={15}
                          strokeWidth={1.75}
                          style={{ color: "var(--cr-ink-2)" }}
                        />
                        <Link href={`/retail/${c.id}`} className="cr-link">
                          {c.filename}
                        </Link>
                      </span>
                    </td>
                    <td className="cr-mono">{c.cutoffDate}</td>
                    <td>
                      <Badge tono={TONO[c.status] ?? "neutro"}>{c.status}</Badge>
                    </td>
                    <td className="num">{fmtNum(c.filas)}</td>
                    <td className="num">{c.issues > 0 ? fmtNum(c.issues) : "—"}</td>
                    <td>{c.uploadedBy}</td>
                    <td className="cr-mono">{fmtFechaHora(c.createdAt)}</td>
                    <td>
                      <span className="flex gap-1">
                        <Link
                          href={`/retail/${c.id}`}
                          className="cr-btn cr-btn--ghost cr-btn--sm"
                          title="Ver detalle"
                        >
                          <Eye strokeWidth={1.75} />
                        </Link>
                        <Link
                          href={`/retail/${c.id}/scorecard`}
                          className="cr-btn cr-btn--ghost cr-btn--sm"
                          title="Scorecard"
                        >
                          SC
                        </Link>
                        {esSuperadmin ? (
                          <button
                            type="button"
                            className="cr-btn cr-btn--ghost cr-btn--sm"
                            title="Borrar carga"
                            style={{ color: "var(--cr-danger)" }}
                            onClick={() => borrar(c.id, c.filename)}
                          >
                            <Trash2 strokeWidth={1.75} />
                          </button>
                        ) : null}
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <Paginacion pagina={pagina} paginas={paginas} total={total} onCambiar={setPagina} />
      </section>
    </div>
  );
}
