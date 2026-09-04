"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronRight, KeyRound, Pencil, ShieldOff, UserPlus } from "lucide-react";
import { api, ClientApiError } from "@/components/lib/api-client";
import { fmtFecha } from "@/components/lib/fmt";
import { Badge, Panel } from "@/components/ui/basicos";
import {
  expandirModulos,
  MODULE_NAMES,
  type ModuleId,
  NAV_SECTIONS,
  type NavSection,
} from "@/lib/rbac";

interface UsuarioFila {
  id: string;
  email: string;
  name: string;
  role: string;
  modules: string[];
  active: boolean;
  createdAt: string;
}

interface Formulario {
  id: string | null; // null = crear
  email: string;
  name: string;
  password: string;
  modules: string[];
  active: boolean;
}

const FORM_VACIO: Formulario = {
  id: null,
  email: "",
  name: "",
  password: "",
  modules: [],
  active: true,
};

/** Los permisos que se pueden marcar en una sección, uno por página. */
function permisosDeSeccion(seccion: NavSection): ModuleId[] {
  return seccion.items.map((i) => i.module).filter((m): m is ModuleId => m !== null);
}

// Texto del contador que va en la cabecera de cada sección cerrada: sin abrirla
// se ve de un vistazo a cuántas páginas entra el usuario.
function resumenSeccion(seccion: NavSection, modules: string[]): string {
  const permisos = permisosDeSeccion(seccion);
  if (permisos.length === 0) return "siempre visible";
  const dados = permisos.filter((m) => modules.includes(m)).length;
  if (dados === 0) return "sin acceso";
  return dados === permisos.length ? `todo (${dados})` : `${dados} de ${permisos.length}`;
}

export function UsuariosAdmin({ esSuperadmin }: { esSuperadmin: boolean }) {
  const [usuarios, setUsuarios] = useState<UsuarioFila[]>([]);
  const [form, setForm] = useState<Formulario | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);
  // Secciones desplegadas del formulario; arrancan cerradas para que el alta se
  // lea de corrido y se abra solo lo que se quiera revisar.
  const [seccionesAbiertas, setSeccionesAbiertas] = useState<string[]>([]);

  const cargar = useCallback(async () => {
    try {
      const r = await api<{ usuarios: UsuarioFila[] }>("/api/admin/usuarios");
      setUsuarios(r.usuarios);
    } catch (e) {
      setError(e instanceof ClientApiError ? e.message : "No se pudieron cargar los usuarios");
    }
  }, []);

  useEffect(() => {
    // fetch-on-mount: el flag de carga se activa al iniciar la petición.
    // Los setState ocurren tras el await, ya fuera del render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void cargar();
  }, [cargar]);

  // El formulario siempre abre con las secciones cerradas: se ve entero de un
  // vistazo y se despliega sólo lo que se quiera revisar. El contador de cada
  // cabecera ya dice si el usuario entra ahí sin necesidad de abrirla.
  function abrirForm(valores: Formulario) {
    setForm(valores);
    setSeccionesAbiertas([]);
  }

  function alternarSeccion(id: string) {
    setSeccionesAbiertas((abiertas) =>
      abiertas.includes(id) ? abiertas.filter((x) => x !== id) : [...abiertas, id],
    );
  }

  // Alta y baja de módulos siempre por esta vía: así una sección con varias
  // páginas del mismo módulo no puede dejar el arreglo con duplicados.
  function fijarModulos(ids: string[], activar: boolean) {
    setForm((actual) => {
      if (!actual) return actual;
      const modules = activar
        ? [...actual.modules.filter((m) => !ids.includes(m)), ...ids]
        : actual.modules.filter((m) => !ids.includes(m));
      return { ...actual, modules };
    });
  }

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
            name: form.name,
            password: form.password,
            modules: form.modules,
            active: form.active,
          }),
        });
      } else {
        await api(`/api/admin/usuarios/${form.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            name: form.name,
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
      const r = await api<{ message: string }>(`/api/admin/usuarios/${u.id}`, {
        method: "POST",
        body: JSON.stringify({ accion }),
      });
      setAviso(r.message);
    } catch (e) {
      setError(e instanceof ClientApiError ? e.message : "No se pudo ejecutar la acción");
    }
  }

  return (
    <div className="cr-stack">
      {esSuperadmin ? (
        <div>
          <button
            type="button"
            className="cr-btn cr-btn--primary"
            onClick={() => abrirForm({ ...FORM_VACIO })}
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
                <th>Accesos</th>
                <th>Estado</th>
                <th>Alta</th>
                {esSuperadmin ? <th>Acciones</th> : null}
              </tr>
            </thead>
            <tbody>
              {usuarios.map((u) => (
                <tr key={u.id}>
                  <td>{u.name}</td>
                  <td className="cr-mono">{u.email}</td>
                  <td>
                    {u.role === "superadmin" ? <Badge tono="danger">superadmin</Badge> : <Badge>user</Badge>}
                  </td>
                  <td>
                    <span className="flex flex-wrap gap-1">
                      {u.role === "superadmin" ? (
                        <span className="cr-small">todos</span>
                      ) : (
                        expandirModulos(u.modules).map((m) => (
                          <Badge key={m}>{MODULE_NAMES.get(m) ?? m}</Badge>
                        ))
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
                            abrirForm({
                              id: u.id,
                              email: u.email,
                              name: u.name,
                              password: "",
                              // Expandidos: un usuario guardado con el
                              // permiso viejo de sección aparece con sus
                              // páginas marcadas, y al guardar queda migrado.
                              modules: expandirModulos(u.modules),
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
        <div className="cr-modal">
          <form onSubmit={guardar} className="cr-modal__caja">
            <div className="cr-modal__head">
              <h2 className="cr-h2">{form.id === null ? "Nuevo usuario" : "Editar usuario"}</h2>
            </div>
            <div className="cr-modal__cuerpo">
              <label className="cr-field">
                <span className="cr-label">Nombre</span>
                <input
                  className="cr-input"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
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
                <span className="cr-label">Qué puede ver este usuario</span>
                <div className="cr-accesos">
                  {NAV_SECTIONS.map((seccion) => {
                    const permisos = permisosDeSeccion(seccion);
                    // Una sección sin permisos —General— la ve cualquiera con
                    // sesión: se muestra para que se entienda el menú completo,
                    // pero no hay nada que marcar.
                    const fija = permisos.length === 0;
                    const abierta = seccionesAbiertas.includes(seccion.id);
                    const todos = permisos.every((m) => form.modules.includes(m));
                    const algunos = permisos.some((m) => form.modules.includes(m));
                    return (
                      <div key={seccion.id} className="cr-acceso">
                        <div className="cr-acceso__head">
                          <input
                            type="checkbox"
                            className="cr-acceso__check"
                            checked={fija || todos}
                            disabled={fija}
                            aria-label={`Dar acceso a toda la sección ${seccion.name}`}
                            ref={(el) => {
                              if (el) el.indeterminate = !fija && algunos && !todos;
                            }}
                            onChange={(e) => fijarModulos(permisos, e.target.checked)}
                          />
                          <button
                            type="button"
                            className="cr-acceso__toggle"
                            aria-expanded={abierta}
                            onClick={() => alternarSeccion(seccion.id)}
                          >
                            <span className="cr-acceso__nombre">{seccion.name}</span>
                            <span className="cr-acceso__resumen">
                              {resumenSeccion(seccion, form.modules)}
                            </span>
                            <ChevronRight
                              strokeWidth={1.75}
                              className={`cr-acceso__chevron${abierta ? " cr-acceso__chevron--abierto" : ""}`}
                            />
                          </button>
                        </div>
                        {abierta ? (
                          <div className="cr-acceso__cuerpo">
                            {seccion.items.map((item) => {
                              const permiso = item.module;
                              return permiso === null ? (
                                <p key={item.href} className="cr-acceso__fija">
                                  {item.label} <span className="cr-acceso__ruta">{item.href}</span>
                                  <span className="cr-acceso__nota">Visible para todos</span>
                                </p>
                              ) : (
                                <label key={item.href} className="cr-acceso__pagina">
                                  <input
                                    type="checkbox"
                                    checked={form.modules.includes(permiso)}
                                    onChange={(e) => fijarModulos([permiso], e.target.checked)}
                                  />
                                  {item.label}
                                  <span className="cr-acceso__ruta">{item.href}</span>
                                </label>
                              );
                            })}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
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
            </div>
            <div className="cr-modal__pie">
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
          </form>
        </div>
      ) : null}
    </div>
  );
}
