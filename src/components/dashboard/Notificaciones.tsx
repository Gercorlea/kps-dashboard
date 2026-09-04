"use client";

import { Bell } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ClientApiError } from "@/components/lib/api-client";
import { fmtFecha } from "@/components/lib/fmt";

// Campana de avisos. NO hay un modelo de notificaciones en este proyecto, y no
// se inventa uno: lo que cuenta son las PETICIONES PENDIENTES, que es trabajo
// real esperando decisión de KPS y ya vive en /api/peticiones. El propio
// endpoint devuelve el contador ya filtrado (sin archivadas), así que aquí no
// se recalcula nada.

type Peticion = {
  folio: string;
  proveedor: string;
  total: string;
  moneda: string;
  enviada: string | null;
};

const CADA = 60_000;

export function Notificaciones() {
  const [pendientes, setPendientes] = useState(0);
  const [items, setItems] = useState<Peticion[]>([]);
  const [abierto, setAbierto] = useState(false);
  // Sin el módulo de peticiones la API responde 403. En vez de duplicar aquí
  // las reglas de rbac —y arriesgarse a que las dos copias se separen—, se
  // pregunta y se esconde la campana si no hay permiso.
  const [permitido, setPermitido] = useState(true);
  const caja = useRef<HTMLDivElement>(null);

  const cargar = useCallback(async () => {
    try {
      const r = await api<{ pendientes: number; peticiones: Peticion[] }>(
        "/api/peticiones?estatus=pendientes"
      );
      setPendientes(r.pendientes);
      setItems(r.peticiones.slice(0, 6));
    } catch (e) {
      if (e instanceof ClientApiError && (e.status === 403 || e.status === 401)) {
        setPermitido(false);
      }
    }
  }, []);

  useEffect(() => {
    // fetch-on-mount: la primera lectura tiene que salir al montar, si no la
    // campana se queda en cero hasta que pase el primer minuto del intervalo.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void cargar();
    const t = setInterval(() => void cargar(), CADA);
    return () => clearInterval(t);
  }, [cargar]);

  // Cerrar al pulsar fuera. Se escucha en captura para que el clic sobre otro
  // control lo cierre antes de que ese control actúe.
  useEffect(() => {
    if (!abierto) return;
    const fuera = (e: MouseEvent) => {
      if (caja.current && !caja.current.contains(e.target as Node)) setAbierto(false);
    };
    document.addEventListener("mousedown", fuera, true);
    return () => document.removeEventListener("mousedown", fuera, true);
  }, [abierto]);

  if (!permitido) return null;

  return (
    <div className="cr-campana" ref={caja}>
      <button
        type="button"
        className="cr-campana__btn"
        aria-label={`Avisos${pendientes ? `: ${pendientes} peticiones pendientes` : ""}`}
        aria-expanded={abierto}
        onClick={() => {
          setAbierto((v) => !v);
          if (!abierto) void cargar();
        }}
      >
        <Bell strokeWidth={1.75} />
        {pendientes > 0 ? (
          <span className="cr-campana__badge">{pendientes > 9 ? "9+" : pendientes}</span>
        ) : null}
      </button>

      {abierto ? (
        <div className="cr-campana__panel" role="dialog" aria-label="Avisos">
          <div className="cr-campana__head">
            <span className="cr-label">Peticiones pendientes</span>
            <span className="cr-mono">{pendientes}</span>
          </div>

          {items.length === 0 ? (
            <p className="cr-campana__vacio">No hay peticiones esperando decisión.</p>
          ) : (
            <ul className="cr-campana__lista">
              {items.map((p) => (
                <li key={p.folio}>
                  <Link
                    href={`/peticiones?folio=${encodeURIComponent(p.folio)}`}
                    className="cr-campana__item"
                    onClick={() => setAbierto(false)}
                  >
                    <span className="cr-campana__folio cr-mono">{p.folio}</span>
                    <span className="cr-campana__prov">{p.proveedor}</span>
                    <span className="cr-campana__fecha cr-mono">{fmtFecha(p.enviada)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}

          <Link href="/peticiones" className="cr-campana__pie" onClick={() => setAbierto(false)}>
            Ver todas
          </Link>
        </div>
      ) : null}
    </div>
  );
}
