"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, RefreshCw, Search } from "lucide-react";
import { api, ClientApiError } from "@/components/lib/api-client";
import { Badge, Panel } from "@/components/ui/basicos";

// Alta de proveedores del portal.
//
// Lo único que se captura es el TIPO. Todo lo demás —código, razón social,
// RFC, moneda— viene de Business One y es de solo lectura: capturarlo a mano
// abriría la puerta a que el portal y SAP discrepen sobre quién es quién.

interface Proveedor {
  cardCode: string;
  nombre: string;
  rfc: string | null;
  moneda: string | null;
  saldo: number | null;
  activoEnSap: boolean;
  portal: { type: string; status: string } | null;
  /** Correos que ya pueden entrar al portal por este proveedor. */
  accesos: string[];
}

interface Respuesta {
  total: number;
  registrados: number;
  coinciden: number;
  proveedores: Proveedor[];
}

const TIPOS = [
  { id: "MERCANCIA", etiqueta: "Comercial · mercancía" },
  { id: "SERVICIO", etiqueta: "Servicios" },
] as const;

function consulta(q: string, refrescar: boolean): string {
  const params = new URLSearchParams();
  if (q.trim()) params.set("q", q.trim());
  if (refrescar) params.set("refrescar", "1");
  return params.toString();
}

function money(v: number | null, moneda: string | null): string {
  if (v === null || v === undefined) return "—";
  const n = new Intl.NumberFormat("es-MX", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(v);
  return `${n} ${moneda ?? ""}`.trim();
}

export function ProveedoresAdmin() {
  const [datos, setDatos] = useState<Respuesta | null>(null);
  const [busqueda, setBusqueda] = useState("");
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  // Tipo elegido por fila, antes de guardar. Un solo mapa para todas: guardar
  // uno por fila obligaría a un componente por fila.
  const [tipos, setTipos] = useState<Record<string, string>>({});
  // Correo y contraseña por fila. Mismo motivo que `tipos`: un mapa para todas
  // en vez de un componente por fila.
  const [correos, setCorreos] = useState<Record<string, string>>({});
  const [claves, setClaves] = useState<Record<string, string>>({});
  const [guardando, setGuardando] = useState<string | null>(null);

  // Sin setState sincrono al entrar: llamarla desde un efecto dispararia
  // renders en cascada. El indicador de carga lo enciende quien la invoca a
  // mano; en el montaje ya arranca en true.
  const cargar = useCallback(async (q: string, refrescar = false) => {
    try {
      const r = await api<Respuesta>(`/api/proveedores?${consulta(q, refrescar)}`);
      setDatos(r);
      setCargando(false);
    } catch (e) {
      setError(
        e instanceof ClientApiError ? e.message : "No se pudo leer el padrón de Business One"
      );
      setCargando(false);
    }
  }, []);

  useEffect(() => {
    // fetch-on-mount: `cargando` ya arranca en true.
    // Carga inicial. Los setState ocurren tras el await, ya fuera del render:
    // es el mismo patron que UsuariosAdmin, y la regla lo marca aqui solo
    // porque `cargar` recibe argumentos y no puede seguir la llamada.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void cargar("");
  }, [cargar]);

  // Se busca al enviar y no en cada tecla: el filtrado ocurre en el servidor
  // sobre el padrón cacheado, y una petición por letra no aporta nada.
  function buscar(e: React.FormEvent) {
    e.preventDefault();
    setCargando(true);
    setError(null);
    void cargar(busqueda);
  }

  async function registrar(p: Proveedor) {
    const type = tipos[p.cardCode] ?? p.portal?.type ?? "MERCANCIA";
    setGuardando(p.cardCode);
    setError(null);
    setAviso(null);
    try {
      const r = await api<{
        creado: boolean;
        acceso: { email: string; creado: boolean; passwordActualizada: boolean } | null;
      }>("/api/proveedores", {
        method: "POST",
        body: JSON.stringify({
          cardCode: p.cardCode,
          type,
          email: correos[p.cardCode] ?? p.accesos[0] ?? "",
          password: claves[p.cardCode] ?? "",
        }),
      });
      const partes = [
        r.creado
          ? `${p.nombre} registrado como ${type === "SERVICIO" ? "servicios" : "comercial"}.`
          : `${p.nombre} actualizado.`,
      ];
      if (r.acceso) {
        partes.push(
          r.acceso.creado
            ? `Acceso creado para ${r.acceso.email}.`
            : r.acceso.passwordActualizada
              ? `Contraseña de ${r.acceso.email} actualizada.`
              : `Acceso de ${r.acceso.email} sin cambios de contraseña.`
        );
      }
      setAviso(partes.join(" "));
      // La contraseña no se queda en memoria del navegador después de enviarla.
      setClaves((c) => ({ ...c, [p.cardCode]: "" }));
      await cargar(busqueda);
    } catch (e) {
      setError(e instanceof ClientApiError ? e.message : "No se pudo registrar el proveedor");
    } finally {
      setGuardando(null);
    }
  }

  return (
    <div className="cr-stack">
      <Panel
        title="Padrón de Business One"
        acciones={
          <button
            type="button"
            className="cr-btn cr-btn--ghost cr-btn--sm"
            onClick={() => {
              setCargando(true);
              setError(null);
              void cargar(busqueda, true);
            }}
            disabled={cargando}
          >
            <RefreshCw size={14} strokeWidth={1.75} /> Actualizar desde SAP
          </button>
        }
      >
        <form onSubmit={buscar} className="cr-field">
          <label className="cr-label" htmlFor="q">
            Código, RFC o razón social
          </label>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              id="q"
              className="cr-input"
              value={busqueda}
              onChange={(e) => setBusqueda(e.target.value)}
              placeholder="P0010, Biofarma o BNC000531CN5"
              autoComplete="off"
            />
            <button type="submit" className="cr-btn cr-btn--primary" disabled={cargando}>
              <Search size={14} strokeWidth={1.75} /> Buscar
            </button>
          </div>
        </form>

        <p className="cr-small">
          El correo y la contraseña son opcionales: sin ellos el proveedor queda
          registrado pero todavía no puede entrar al portal. Con la fila ya registrada,
          dejar la contraseña vacía conserva la que tenga.
        </p>

        {datos ? (
          <p className="cr-small">
            {datos.total} proveedores en Business One · {datos.registrados} registrados en el portal
            {busqueda.trim() ? ` · ${datos.coinciden} coinciden` : ""}
          </p>
        ) : null}

        {error ? <p className="cr-error">{error}</p> : null}
        {aviso ? <p className="cr-small">{aviso}</p> : null}
      </Panel>

      <Panel title="Proveedores" sinPadding>
        <div className="cr-table-scroll">
          <table className="cr-table">
            <thead>
              <tr>
                <th>Código</th>
                <th>Razón social</th>
                <th>RFC</th>
                <th>Saldo</th>
                <th>SAP</th>
                <th>Portal</th>
                <th>Tipo</th>
                <th>Correo de acceso</th>
                <th>Contraseña</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {datos?.proveedores.map((p) => {
                const tipo = tipos[p.cardCode] ?? p.portal?.type ?? "MERCANCIA";
                return (
                  <tr key={p.cardCode}>
                    <td>{p.cardCode}</td>
                    <td>{p.nombre}</td>
                    <td>{p.rfc ?? "—"}</td>
                    <td>{money(p.saldo, p.moneda)}</td>
                    <td>
                      <Badge tono={p.activoEnSap ? "ok" : "danger"}>
                        {p.activoEnSap ? "Activo" : "Inactivo"}
                      </Badge>
                    </td>
                    <td>
                      {p.portal ? (
                        <Badge tono="ok">
                          {p.portal.type === "SERVICIO" ? "Servicios" : "Comercial"}
                        </Badge>
                      ) : (
                        <Badge>No registrado</Badge>
                      )}
                    </td>
                    <td>
                      <select
                        className="cr-input"
                        value={tipo}
                        onChange={(e) =>
                          setTipos((t) => ({ ...t, [p.cardCode]: e.target.value }))
                        }
                        aria-label={`Tipo de ${p.nombre}`}
                      >
                        {TIPOS.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.etiqueta}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <input
                        className="cr-input"
                        type="email"
                        autoComplete="off"
                        // Arranca con el correo ya registrado; si no hay,
                        // queda vacío. Mostrarlo vacío teniendo uno hacía
                        // creer que no se había guardado.
                        value={correos[p.cardCode] ?? p.accesos[0] ?? ""}
                        placeholder="facturacion@proveedor.com"
                        onChange={(e) =>
                          setCorreos((c) => ({ ...c, [p.cardCode]: e.target.value }))
                        }
                        aria-label={`Correo de acceso de ${p.nombre}`}
                      />
                      {p.accesos.length > 1 ? (
                        <div className="cr-small">
                          {p.accesos.length} accesos: {p.accesos.join(", ")}
                        </div>
                      ) : null}
                    </td>
                    <td>
                      <input
                        className="cr-input"
                        type="password"
                        autoComplete="new-password"
                        value={claves[p.cardCode] ?? ""}
                        placeholder={
                          p.accesos.length > 0 ? "vacío = no cambiarla" : "mín. 8 caracteres"
                        }
                        onChange={(e) =>
                          setClaves((c) => ({ ...c, [p.cardCode]: e.target.value }))
                        }
                        aria-label={`Contraseña de ${p.nombre}`}
                      />
                    </td>
                    <td>
                      <button
                        type="button"
                        className="cr-btn cr-btn--primary cr-btn--sm"
                        onClick={() => void registrar(p)}
                        disabled={guardando === p.cardCode || !p.rfc}
                        // Ningún botón deshabilitado sin explicación al lado:
                        // sin RFC el alta no puede prosperar y hay que decirlo.
                        title={
                          p.rfc
                            ? undefined
                            : "Sin RFC en Business One no se puede registrar: las validaciones del CFDI lo necesitan."
                        }
                      >
                        {guardando === p.cardCode ? (
                          "Guardando…"
                        ) : p.portal ? (
                          <>
                            <RefreshCw size={14} strokeWidth={1.75} /> Actualizar
                          </>
                        ) : (
                          <>
                            <Check size={14} strokeWidth={1.75} /> Registrar
                          </>
                        )}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}
