"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronRight, KeyRound, Pencil, Search, ShieldOff, UserPlus, X } from "lucide-react";
import { Paginacion } from "@/components/dashboard/Paginacion";
import { api, ClientApiError } from "@/components/lib/api-client";
import { fmtFecha } from "@/components/lib/fmt";
import { useFilasQueCaben } from "@/components/lib/useFilasQueCaben";
import { Aviso, Badge, Campo, EstadoVacio, Panel, Tabla } from "@/components/ui/basicos";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import {
  expandirModulos,
  MODULE_IDS,
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

/** Alto de una fila a densidad compacta con botones dentro. */
const ALTO_FILA = 41;

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

function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

/**
 * Resumen de accesos para la columna de la tabla.
 *
 * Antes se pintaba UN BADGE POR MÓDULO. Con seis permisos la celda se envolvía
 * en dos y tres líneas, cada fila medía distinto según a qué entrara el usuario,
 * y la tabla dejaba de poder barrerse en vertical. El detalle completo sigue
 * disponible en el `title` y a un clic en Editar, que es donde se cambia.
 */
function Accesos({ usuario }: { usuario: UsuarioFila }) {
  if (usuario.role === "superadmin") return <Badge tono="ok">todos</Badge>;

  const dados = expandirModulos(usuario.modules);
  if (dados.length === 0) return <Badge tono="warn">sin accesos</Badge>;

  const nombres = dados.map((m) => MODULE_NAMES.get(m) ?? m).join(", ");
  return (
    <span title={nombres}>
      <Badge>
        {dados.length} de {MODULE_IDS.length}
      </Badge>
    </span>
  );
}

export function UsuariosAdmin({ esSuperadmin }: { esSuperadmin: boolean }) {
  const [usuarios, setUsuarios] = useState<UsuarioFila[] | null>(null);
  const [busqueda, setBusqueda] = useState("");
  const [pagina, setPagina] = useState(1);
  const [form, setForm] = useState<Formulario | null>(null);
  // `error` es solo el fallo de CARGA: deja la pantalla sin datos. Los acuses de
  // cada acción van por toast.
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);
  const toast = useToast();
  // Secciones desplegadas del formulario; arrancan cerradas para que el alta se
  // lea de corrido y se abra solo lo que se quiera revisar.
  const [seccionesAbiertas, setSeccionesAbiertas] = useState<string[]>([]);

  const cargar = useCallback(async () => {
    try {
      const r = await api<{ usuarios: UsuarioFila[] }>("/api/admin/usuarios");
      setUsuarios(r.usuarios);
    } catch (e) {
      setError(e instanceof ClientApiError ? e.message : "No se pudieron cargar los usuarios");
      setUsuarios([]);
    }
  }, []);

  useEffect(() => {
    // fetch-on-mount. Los setState ocurren tras el await, ya fuera del render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void cargar();
  }, [cargar]);

  const termino = normalizar(busqueda.trim());
  const visibles = useMemo(
    () =>
      !usuarios
        ? []
        : termino
          ? usuarios.filter((u) =>
              [u.name, u.email, u.role].some((c) => normalizar(c).includes(termino))
            )
          : usuarios,
    [usuarios, termino]
  );

  const { ancla, filas: porPagina } = useFilasQueCaben({
    altoFila: ALTO_FILA,
    recalcularCon: [visibles.length, usuarios],
  });
  const tamano = porPagina ?? 10;
  const paginas = Math.max(1, Math.ceil(visibles.length / tamano));
  const paginaActual = Math.min(pagina, paginas);
  const enPagina = visibles.slice((paginaActual - 1) * tamano, paginaActual * tamano);

  // El formulario siempre abre con las secciones cerradas: se ve entero de un
  // vistazo y se despliega sólo lo que se quiera revisar. El contador de cada
  // cabecera ya dice si el usuario entra ahí sin necesidad de abrirla.
  function abrirForm(valores: Formulario) {
    setForm(valores);
    setSeccionesAbiertas([]);
  }

  function alternarSeccion(id: string) {
    setSeccionesAbiertas((abiertas) =>
      abiertas.includes(id) ? abiertas.filter((x) => x !== id) : [...abiertas, id]
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
        toast.ok(`${form.name} dado de alta`, form.email);
      } else {
        await api(`/api/admin/usuarios/${form.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            name: form.name,
            modules: form.modules,
            active: form.active,
          }),
        });
        toast.ok(`${form.name} actualizado`);
      }
      setForm(null);
      void cargar();
    } catch (err) {
      toast.error(
        "No se pudo guardar",
        err instanceof ClientApiError ? err.message : undefined
      );
    } finally {
      setGuardando(false);
    }
  }

  async function alternarActivo(u: UsuarioFila) {
    try {
      await api(`/api/admin/usuarios/${u.id}`, {
        method: "PATCH",
        body: JSON.stringify({ active: !u.active }),
      });
      toast.ok(u.active ? `${u.name} desactivado` : `${u.name} activado`);
      void cargar();
    } catch (e) {
      toast.error(
        "No se pudo actualizar",
        e instanceof ClientApiError ? e.message : undefined
      );
    }
  }

  async function accion(u: UsuarioFila, accion: "reset-password" | "revocar-sesiones") {
    try {
      const r = await api<{ message: string }>(`/api/admin/usuarios/${u.id}`, {
        method: "POST",
        body: JSON.stringify({ accion }),
      });
      toast.ok(u.name, r.message);
    } catch (e) {
      toast.error(
        "No se pudo ejecutar la acción",
        e instanceof ClientApiError ? e.message : undefined
      );
    }
  }

  const controles = (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative">
        <Search
          className="pointer-events-none absolute top-1/2 left-2.5 h-3 w-3 -translate-y-1/2 text-[color:var(--cr-ink-3)]"
          strokeWidth={1.75}
          aria-hidden="true"
        />
        <input
          className="cr-input cr-input--sm cr-input--busca w-52"
          value={busqueda}
          onChange={(e) => {
            setBusqueda(e.target.value);
            setPagina(1);
          }}
          placeholder="Nombre o correo"
          aria-label="Filtrar usuarios por nombre o correo"
        />
        {busqueda ? (
          <button
            type="button"
            onClick={() => {
              setBusqueda("");
              setPagina(1);
            }}
            className="absolute top-1/2 right-2 -translate-y-1/2 text-[color:var(--cr-ink-3)] hover:text-[color:var(--cr-ink)]"
            aria-label="Limpiar búsqueda"
          >
            <X className="h-3 w-3" strokeWidth={1.75} />
          </button>
        ) : null}
      </div>
      {/* El alta vive en la cabecera del panel, no suelta encima: es una acción
          sobre esta lista, no sobre la pantalla. */}
      {esSuperadmin ? (
        <button
          type="button"
          className="cr-btn cr-btn--primary cr-btn--sm"
          onClick={() => abrirForm({ ...FORM_VACIO })}
        >
          <UserPlus strokeWidth={1.75} />
          Nuevo usuario
        </button>
      ) : null}
    </div>
  );

  return (
    <>
      {error ? (
        <Aviso tono="danger" titulo="No se pudieron cargar los usuarios">
          {error}
        </Aviso>
      ) : null}

      <Panel
        title="Usuarios"
        subtitulo={
          usuarios
            ? termino
              ? `${visibles.length} de ${usuarios.length}`
              : `${usuarios.length} con acceso al dashboard`
            : undefined
        }
        acciones={controles}
        sinPadding
      >
        <div ref={ancla}>
          {!usuarios ? (
            <p className="cr-body px-[18px] py-16 text-center">Leyendo los usuarios…</p>
          ) : visibles.length === 0 ? (
            <EstadoVacio
              title={termino ? "No hay resultados para esa búsqueda" : "No hay usuarios"}
              detalle={
                termino ? `Ningún usuario coincide con "${busqueda}".` : undefined
              }
            />
          ) : (
            <Tabla densidad="compacta" fija>
              <colgroup>
                <col />
                <col style={{ width: 240 }} />
                <col style={{ width: 116 }} />
                <col style={{ width: 108 }} />
                <col style={{ width: 96 }} />
                <col style={{ width: 104 }} />
                {esSuperadmin ? <col style={{ width: 208 }} /> : null}
              </colgroup>
              <thead>
                <tr>
                  <th>Nombre</th>
                  <th>Correo</th>
                  <th>Rol</th>
                  <th>Accesos</th>
                  <th>Estado</th>
                  <th>Alta</th>
                  {esSuperadmin ? <th /> : null}
                </tr>
              </thead>
              <tbody>
                {enPagina.map((u) => (
                  <tr key={u.id} className="whitespace-nowrap">
                    <td className="min-w-0 truncate" title={u.name}>
                      {u.name}
                    </td>
                    <td className="cr-mono min-w-0 truncate" title={u.email}>
                      {u.email}
                    </td>
                    <td>
                      {u.role === "superadmin" ? (
                        <Badge tono="danger">superadmin</Badge>
                      ) : (
                        <Badge>user</Badge>
                      )}
                    </td>
                    <td>
                      <Accesos usuario={u} />
                    </td>
                    <td>
                      {u.active ? (
                        <Badge tono="ok">activo</Badge>
                      ) : (
                        <Badge tono="danger">inactivo</Badge>
                      )}
                    </td>
                    <td className="cr-mono">{fmtFecha(u.createdAt)}</td>
                    {esSuperadmin ? (
                      <td>
                        <div className="flex justify-end gap-1">
                          {/* `aria-label` y no solo `title`: un botón que solo
                              tiene un icono dentro no tiene nombre accesible, y
                              el `title` no cuenta como tal de forma fiable. */}
                          <button
                            type="button"
                            className="cr-btn cr-btn--ghost cr-btn--sm"
                            title="Editar"
                            aria-label={`Editar ${u.name}`}
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
                            aria-label={`Enviar correo de restablecimiento a ${u.name}`}
                            onClick={() => accion(u, "reset-password")}
                          >
                            <KeyRound strokeWidth={1.75} />
                          </button>
                          <button
                            type="button"
                            className="cr-btn cr-btn--ghost cr-btn--sm"
                            title="Revocar sesiones"
                            aria-label={`Revocar las sesiones de ${u.name}`}
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
                        </div>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </Tabla>
          )}
        </div>

        {usuarios && visibles.length > 0 ? (
          <Paginacion
            pagina={paginaActual}
            paginas={paginas}
            total={visibles.length}
            porPagina={tamano}
            onCambiar={setPagina}
            sustantivo="usuarios"
          />
        ) : null}
      </Panel>

      {form ? (
        <Modal
          como="form"
          titulo={form.id === null ? "Nuevo usuario" : "Editar usuario"}
          subtitulo={form.id === null ? undefined : form.email}
          onCerrar={() => setForm(null)}
          onSubmit={guardar}
          pie={
            <>
              <button
                type="button"
                className="cr-btn cr-btn--ghost cr-btn--sm"
                onClick={() => setForm(null)}
              >
                Cancelar
              </button>
              <button
                type="submit"
                className="cr-btn cr-btn--primary cr-btn--sm"
                disabled={guardando}
              >
                {guardando ? "Guardando…" : "Guardar"}
              </button>
            </>
          }
        >
          <Campo label="Nombre">
            <input
              className="cr-input cr-input--sm"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              required
            />
          </Campo>
          {/* Al editar, el correo es la identidad del usuario y no se cambia:
              se enseña en el subtítulo y el campo desaparece, en vez de dejar un
              input deshabilitado ocupando sitio. */}
          {form.id === null ? (
            <>
              <Campo label="Correo">
                <input
                  className="cr-input cr-input--sm"
                  type="email"
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                  required
                />
              </Campo>
              <Campo label="Contraseña inicial" ayuda="Mínimo 8 caracteres.">
                <input
                  className="cr-input cr-input--sm"
                  type="password"
                  minLength={8}
                  value={form.password}
                  onChange={(e) => setForm({ ...form, password: e.target.value })}
                  required
                />
              </Campo>
            </>
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

          <label className="cr-check">
            <input
              type="checkbox"
              checked={form.active}
              onChange={(e) => setForm({ ...form, active: e.target.checked })}
            />
            Usuario activo
          </label>
        </Modal>
      ) : null}
    </>
  );
}
