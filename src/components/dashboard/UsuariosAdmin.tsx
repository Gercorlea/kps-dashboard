"use client";

import { useCallback, useEffect, useState } from "react";
import { KeyRound, Pencil, ShieldOff, UserPlus } from "lucide-react";
import { api, ClientApiError } from "@/components/lib/api-client";
import { fmtFecha } from "@/components/lib/fmt";
import { Badge, Panel } from "@/components/ui/basicos";
import { MODULES } from "@/lib/rbac";

interface UsuarioFila {
  id: string;
  email: string;
  nombre: string;
  role: string;
  modules: string[];
  active: boolean;
  createdAt: string;
}

interface Formulario {
  id: string | null; // null = crear
  email: string;
  nombre: string;
  password: string;
  modules: string[];
  active: boolean;
}

const FORM_VACIO: Formulario = {
  id: null,
  email: "",
  nombre: "",
  password: "",
  modules: [],
  active: true,
};

export function UsuariosAdmin({ esSuperadmin }: { esSuperadmin: boolean }) {
  const [usuarios, setUsuarios] = useState<UsuarioFila[]>([]);
  const [form, setForm] = useState<Formulario | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  const cargar = useCallback(async () => {
    try {
      const r = await api<{ usuarios: UsuarioFila[] }>("/api/admin/usuarios");
      setUsuarios(r.usuarios);
    } catch (e) {
      setError(e instanceof ClientApiError ? e.message : "No se pudieron cargar los usuarios");
    }
  }, []);

  useEffect(() => {
    // fetch-on-mount: el flag de carga se activa al iniciar la petición
     
    void cargar();
  }, [cargar]);

  async function guardar(e: React.FormEvent) {
    e.preventDefault();
    if (!form) return;
    setGuardando(true);
    setError(null);
    try {
      if (form.id === null) {
        await api("/api/admin/usuarios", {
          method: "POST",
          body: JSON.stringify({
            email: form.email,
            nombre: form.nombre,
            password: form.password,
            modules: form.modules,
            active: form.active,
          }),
        });
      } else {
        await api(`/api/admin/usuarios/${form.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            nombre: form.nombre,
            modules: form.modules,
            active: form.active,
          }),
        });
      }
      setForm(null);
      void cargar();
    } catch (err) {
      setError(err instanceof ClientApiError ? err.message : "No se pudo guardar");
    } finally {
      setGuardando(false);
    }
  }

  async function alternarActivo(u: UsuarioFila) {
    setError(null);
    try {
      await api(`/api/admin/usuarios/${u.id}`, {
        method: "PATCH",
        body: JSON.stringify({ active: !u.active }),
      });
      void cargar();
    } catch (e) {
      setError(e instanceof ClientApiError ? e.message : "No se pudo actualizar");
    }
  }

  async function accion(u: UsuarioFila, accion: "reset-password" | "revocar-sesiones") {
    setError(null);
    setAviso(null);
    try {
      const r = await api<{ mensaje: string }>(`/api/admin/usuarios/${u.id}`, {
        method: "POST",
        body: JSON.stringify({ accion }),
      });
      setAviso(r.mensaje);
    } catch (e) {
      setError(e instanceof ClientApiError ? e.message : "No se pudo ejecutar la acción");
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {esSuperadmin ? (
        <div>
          <button
            type="button"
            className="cr-btn cr-btn--primary"
            onClick={() => setForm({ ...FORM_VACIO })}
          >
            <UserPlus strokeWidth={1.75} />
            Nuevo usuario
          </button>
        </div>
      ) : null}

      {aviso ? (
        <p className="cr-small" style={{ color: "var(--cr-ok)" }}>
          {aviso}
        </p>
      ) : null}
      {error ? (
        <p className="cr-small" style={{ color: "var(--cr-danger)" }} role="alert">
          {error}
        </p>
      ) : null}

      <Panel sinPadding>
        <div className="cr-table-scroll">
          <table className="cr-table">
            <thead>
              <tr>
                <th>Nombre</th>
                <th>Correo</th>
                <th>Rol</th>
                <th>Módulos</th>
                <th>Estado</th>
                <th>Alta</th>
                {esSuperadmin ? <th>Acciones</th> : null}
              </tr>
            </thead>
            <tbody>
              {usuarios.map((u) => (
                <tr key={u.id}>
                  <td>{u.nombre}</td>
                  <td className="cr-mono">{u.email}</td>
                  <td>
                    {u.role === "superadmin" ? <Badge tono="danger">superadmin</Badge> : <Badge>user</Badge>}
                  </td>
                  <td>
                    <span className="flex flex-wrap gap-1">
                      {u.role === "superadmin" ? (
                        <span className="cr-small">todos</span>
                      ) : (
                        u.modules.map((m) => <Badge key={m}>{m}</Badge>)
                      )}
                    </span>
                  </td>
                  <td>
                    {u.active ? <Badge tono="ok">activo</Badge> : <Badge tono="danger">inactivo</Badge>}
                  </td>
                  <td className="cr-mono">{fmtFecha(u.createdAt)}</td>
                  {esSuperadmin ? (
                    <td>
                      <span className="flex gap-1">
                        <button
                          type="button"
                          className="cr-btn cr-btn--ghost cr-btn--sm"
                          title="Editar"
                          onClick={() =>
                            setForm({
                              id: u.id,
                              email: u.email,
                              nombre: u.nombre,
                              password: "",
                              modules: u.modules,
                              active: u.active,
                            })
                          }
                        >
                          <Pencil strokeWidth={1.75} />
                        </button>
                        <button
                          type="button"
                          className="cr-btn cr-btn--ghost cr-btn--sm"
                          title="Enviar correo de restablecimiento"
                          onClick={() => accion(u, "reset-password")}
                        >
                          <KeyRound strokeWidth={1.75} />
                        </button>
                        <button
                          type="button"
                          className="cr-btn cr-btn--ghost cr-btn--sm"
                          title="Revocar sesiones"
                          onClick={() => accion(u, "revocar-sesiones")}
                        >
                          <ShieldOff strokeWidth={1.75} />
                        </button>
                        {u.role !== "superadmin" ? (
                          <button
                            type="button"
                            className="cr-btn cr-btn--secondary cr-btn--sm"
                            onClick={() => alternarActivo(u)}
                          >
                            {u.active ? "Desactivar" : "Activar"}
                          </button>
                        ) : null}
                      </span>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      {form ? (
        <div className="cr-backdrop z-50 flex items-center justify-center p-4">
          <form onSubmit={guardar} className="cr-card w-full max-w-md p-6">
            <h2 className="cr-h2 mb-4">{form.id === null ? "Nuevo usuario" : "Editar usuario"}</h2>
            <div className="flex flex-col gap-4">
              <label className="cr-field">
                <span className="cr-label">Nombre</span>
                <input
                  className="cr-input"
                  value={form.nombre}
                  onChange={(e) => setForm({ ...form, nombre: e.target.value })}
                  required
                />
              </label>
              <label className="cr-field">
                <span className="cr-label">Correo</span>
                <input
                  className="cr-input"
                  type="email"
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                  disabled={form.id !== null}
                  required
                />
              </label>
              {form.id === null ? (
                <label className="cr-field">
                  <span className="cr-label">Contraseña inicial (mínimo 8)</span>
                  <input
                    className="cr-input"
                    type="password"
                    minLength={8}
                    value={form.password}
                    onChange={(e) => setForm({ ...form, password: e.target.value })}
                    required
                  />
                </label>
              ) : null}
              <fieldset className="cr-field">
                <span className="cr-label">Módulos con acceso</span>
                <div className="flex flex-col gap-2">
                  {MODULES.map((m) => (
                    <label key={m.id} className="flex items-center gap-2 text-[13px]">
                      <input
                        type="checkbox"
                        checked={form.modules.includes(m.id)}
                        onChange={(e) =>
                          setForm({
                            ...form,
                            modules: e.target.checked
                              ? [...form.modules, m.id]
                              : form.modules.filter((x) => x !== m.id),
                          })
                        }
                      />
                      {m.nombre}
                    </label>
                  ))}
                </div>
              </fieldset>
              <label className="flex items-center gap-2 text-[13px]">
                <input
                  type="checkbox"
                  checked={form.active}
                  onChange={(e) => setForm({ ...form, active: e.target.checked })}
                />
                Usuario activo
              </label>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  className="cr-btn cr-btn--ghost"
                  onClick={() => setForm(null)}
                >
                  Cancelar
                </button>
                <button type="submit" className="cr-btn cr-btn--primary" disabled={guardando}>
                  Guardar
                </button>
              </div>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}
