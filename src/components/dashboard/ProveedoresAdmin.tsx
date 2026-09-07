"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, RefreshCw, Search, X } from "lucide-react";
import { Paginacion } from "@/components/dashboard/Paginacion";
import { api, ClientApiError } from "@/components/lib/api-client";
import { useFilasQueCaben } from "@/components/lib/useFilasQueCaben";
import { Aviso, Badge, EstadoVacio, Panel, Tabla } from "@/components/ui/basicos";
import { useToast } from "@/components/ui/Toast";

// Alta de proveedores del portal.
//
// Lo único que se captura es el TIPO. Todo lo demás —código, razón social,
// RFC, moneda— viene de Business One y es de solo lectura: capturarlo a mano
// abriría la puerta a que el portal y SAP discrepen sobre quién es quién.
//
// FORMA DE LA PANTALLA: la fila ES el formulario. Tipo, correo, contraseña y el
// botón viven en la propia fila del proveedor, así se dan de alta varios
// seguidos sin ir y volver a un panel de detalle.
//
// Lo que hace que eso funcione sin romper la densidad (§6 del design system):
// controles `.cr-input--sm` (30px en vez de 37), tabla en densidad compacta y
// anchos FIJOS por columna. Sin los anchos fijos, cada fila reparte el espacio
// según lo que mida su contenido y las columnas dejan de alinearse entre filas.

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
  pagina: number;
  paginas: number;
  proveedores: Proveedor[];
}

const TIPOS = [
  { id: "MERCANCIA", etiqueta: "Comercial · mercancía" },
  { id: "SERVICIO", etiqueta: "Servicios" },
] as const;

/* Alto de una fila: control de 30px más el padding de `.cr-table--compact`.
   Es lo que divide el alto disponible para saber cuántas filas caben. */
const ALTO_FILA = 41;

function consulta(q: string, refrescar: boolean, pagina: number, limite: number): string {
  const params = new URLSearchParams();
  params.set("limite", String(limite));
  if (q.trim()) params.set("q", q.trim());
  if (pagina > 1) params.set("pagina", String(pagina));
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
  // `busqueda` es lo que hay escrito en el campo; `consultaActiva` es lo que de
  // verdad se pidió al servidor. Separarlas es lo que deja que el tamaño de
  // página se recalcule sin arrastrar un texto a medio escribir.
  const [busqueda, setBusqueda] = useState("");
  const [consultaActiva, setConsultaActiva] = useState("");
  const [cargando, setCargando] = useState(true);
  // `error` es solo el fallo de CARGA: deja la pantalla sin datos y necesita
  // decir qué hacer, así que se queda fijo. Los acuses de guardado van por
  // toast — en el flujo empujarían la tabla y descuadrarían el paginado.
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  // Un mapa por campo para todas las filas, en vez de un componente por fila.
  const [tipos, setTipos] = useState<Record<string, string>>({});
  const [correos, setCorreos] = useState<Record<string, string>>({});
  const [claves, setClaves] = useState<Record<string, string>>({});
  const [guardando, setGuardando] = useState<string | null>(null);

  // Cuántos proveedores por página: los que quepan en pantalla sin obligar a
  // hacer scroll para llegar al paginador.
  // `recalcularCon: [datos]` no es opcional: en la primera medida todavía se ve
  // el "cargando" y no hay `<thead>` que medir.
  const { ancla, filas } = useFilasQueCaben({ altoFila: ALTO_FILA, recalcularCon: [datos] });

  const cargar = useCallback(
    async (q: string, pagina: number, limite: number, refrescar = false) => {
      try {
        const r = await api<Respuesta>(
          `/api/proveedores?${consulta(q, refrescar, pagina, limite)}`
        );
        setDatos(r);
        setCargando(false);
      } catch (e) {
        setError(
          e instanceof ClientApiError ? e.message : "No se pudo leer el padrón de Business One"
        );
        setCargando(false);
      }
    },
    []
  );

  // Primera carga y recargas por cambio de búsqueda o de tamaño de página.
  // Mientras `filas` sea null todavía no se ha medido la pantalla: pedir ahora
  // sería pedir dos veces.
  useEffect(() => {
    if (filas === null) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCargando(true);
    void cargar(consultaActiva, 1, filas);
  }, [filas, consultaActiva, cargar]);

  // Se busca al enviar y no en cada tecla: el filtrado ocurre en el servidor
  // sobre el padrón cacheado, y una petición por letra no aporta nada.
  function buscar(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setConsultaActiva(busqueda.trim());
  }

  function limpiar() {
    setBusqueda("");
    setConsultaActiva("");
  }

  function paginar(p: number) {
    setCargando(true);
    void cargar(consultaActiva, p, filas ?? 10);
  }

  async function registrar(p: Proveedor) {
    const type = tipos[p.cardCode] ?? p.portal?.type ?? "MERCANCIA";
    setGuardando(p.cardCode);
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
      const titulo = r.creado
        ? `${p.nombre} registrado como ${type === "SERVICIO" ? "servicios" : "comercial"}`
        : `${p.nombre} actualizado`;
      const detalle = r.acceso
        ? r.acceso.creado
          ? `Acceso creado para ${r.acceso.email}.`
          : r.acceso.passwordActualizada
            ? `Contraseña de ${r.acceso.email} actualizada.`
            : `Acceso de ${r.acceso.email} sin cambios de contraseña.`
        : undefined;
      toast.ok(titulo, detalle);
      // La contraseña no se queda en memoria del navegador después de enviarla.
      setClaves((c) => ({ ...c, [p.cardCode]: "" }));
      await cargar(consultaActiva, datos?.pagina ?? 1, filas ?? 10);
    } catch (e) {
      toast.error(
        "No se pudo registrar el proveedor",
        e instanceof ClientApiError ? e.message : undefined
      );
    } finally {
      setGuardando(null);
    }
  }

  // El buscador vive en la cabecera del panel de la lista, no en la de la
  // página: al crecer el contenido la cabecera de página se va de pantalla y el
  // buscador desaparece justo cuando hace falta.
  const buscador = (
    <form onSubmit={buscar} className="relative">
      <Search
        className="pointer-events-none absolute top-1/2 left-2.5 h-3 w-3 -translate-y-1/2 text-[color:var(--cr-ink-3)]"
        strokeWidth={1.75}
        aria-hidden="true"
      />
      <input
        className="cr-input cr-input--sm cr-input--busca w-52"
        value={busqueda}
        onChange={(e) => setBusqueda(e.target.value)}
        placeholder="Código, RFC o razón social"
        aria-label="Buscar proveedor por código, RFC o razón social"
        autoComplete="off"
      />
      {busqueda ? (
        <button
          type="button"
          onClick={limpiar}
          className="absolute top-1/2 right-2 -translate-y-1/2 text-[color:var(--cr-ink-3)] hover:text-[color:var(--cr-ink)]"
          aria-label="Limpiar búsqueda"
        >
          <X className="h-3 w-3" strokeWidth={1.75} />
        </button>
      ) : null}
    </form>
  );

  return (
    <>
      {error ? (
        <Aviso tono="danger" titulo="No se pudo completar la operación">
          {error}
        </Aviso>
      ) : null}
      <Panel title="Padrón de Business One" acciones={buscador} sinPadding>
        {/* Al cambiar de página los datos viejos siguen en pantalla hasta que
            llega la respuesta. Sin señal, la tabla parece no responder al clic;
            atenuada y con `aria-busy` se lee que está trabajando. */}
        <div
          ref={ancla}
          aria-busy={cargando}
          className={cargando && datos ? "opacity-50 transition-opacity" : undefined}
        >
          {/* Tres estados excluyentes. Antes solo existía el tercero: mientras
              cargaba, y también cuando la búsqueda no encontraba nada, se veía
              la tabla con sus encabezados y nada debajo — que se lee como "está
              cargando" en los dos casos, y no dice cuál de los dos es. */}
          {!datos ? (
            <p className="cr-body px-[18px] py-16 text-center">
              Leyendo el padrón de Business One…
            </p>
          ) : datos.proveedores.length === 0 ? (
            <EstadoVacio
              title={
                consultaActiva ? "No hay resultados para esa búsqueda" : "El padrón está vacío"
              }
              detalle={
                consultaActiva
                  ? "Revisa el código, el RFC o la razón social. La búsqueda ignora acentos y mayúsculas."
                  : "Business One no devolvió ningún proveedor."
              }
            />
          ) : (
            /* `fija` y SIN `scroll`: la tabla nunca se desborda de lado. Los
               anchos los manda el colgroup y la razón social —la única columna
               sin ancho— se queda con lo que sobre y recorta con puntos
               suspensivos. Antes esto era `scroll`, y un nombre largo como
               "Dueño Del Mar Woodward Group International Logistic Services
               Think Global" ensanchaba su columna hasta empujar el botón de
               registrar fuera de la pantalla. */
            <Tabla densidad="compacta" fija>
              <colgroup>
                <col style={{ width: 80 }} />
                <col />
                <col style={{ width: 128 }} />
                <col style={{ width: 120 }} />
                <col style={{ width: 76 }} />
                <col style={{ width: 120 }} />
                <col style={{ width: 160 }} />
                <col style={{ width: 190 }} />
                <col style={{ width: 120 }} />
                <col style={{ width: 118 }} />
              </colgroup>
              <thead>
                <tr>
                  <th>Código</th>
                  <th>Razón social</th>
                  <th>RFC</th>
                  <th className="cr-num">Saldo</th>
                  <th>SAP</th>
                  <th>Portal</th>
                  <th>Tipo</th>
                  <th>Correo de acceso</th>
                  <th>Contraseña</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {datos.proveedores.map((p) => {
                  const tipo = tipos[p.cardCode] ?? p.portal?.type ?? "MERCANCIA";
                  const enCurso = guardando === p.cardCode;
                  return (
                    <tr key={p.cardCode} className="whitespace-nowrap">
                      <td className="cr-mono">{p.cardCode}</td>
                      {/* `min-w-0 truncate` solo aquí: es lo único que cede
                          cuando la pantalla se estrecha, para que los controles
                          nunca se monten sobre la columna vecina. */}
                      <td className="min-w-0 truncate" title={p.nombre}>
                        {p.nombre}
                      </td>
                      <td className="cr-mono">{p.rfc ?? "—"}</td>
                      <td className="cr-num">{money(p.saldo, p.moneda)}</td>
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
                          className="cr-input cr-input--sm"
                          value={tipo}
                          onChange={(e) => setTipos((t) => ({ ...t, [p.cardCode]: e.target.value }))}
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
                          className="cr-input cr-input--sm"
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
                          title={
                            p.accesos.length > 1
                              ? `${p.accesos.length} accesos: ${p.accesos.join(", ")}`
                              : undefined
                          }
                        />
                      </td>
                      <td>
                        <input
                          className="cr-input cr-input--sm"
                          type="password"
                          autoComplete="new-password"
                          value={claves[p.cardCode] ?? ""}
                          placeholder={p.accesos.length > 0 ? "sin cambios" : "mín. 8"}
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
                          disabled={enCurso || !p.rfc}
                          // Ningún botón deshabilitado sin explicación al lado:
                          // sin RFC el alta no puede prosperar y hay que decirlo.
                          title={
                            p.rfc
                              ? undefined
                              : "Sin RFC en Business One no se puede registrar: las validaciones del CFDI lo necesitan."
                          }
                        >
                          {enCurso ? (
                            "Guardando…"
                          ) : p.portal ? (
                            <>
                              <RefreshCw strokeWidth={1.75} /> Actualizar
                            </>
                          ) : (
                            <>
                              <Check strokeWidth={1.75} /> Registrar
                            </>
                          )}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </Tabla>
          )}
        </div>

        {datos ? (
          <Paginacion
            pagina={datos.pagina}
            paginas={datos.paginas}
            total={datos.coinciden}
            porPagina={filas ?? 10}
            onCambiar={paginar}
            sustantivo="proveedores"
          />
        ) : null}
      </Panel>
    </>
  );
}
