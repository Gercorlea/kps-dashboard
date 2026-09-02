// Ficha de un reporte guardado: lo que se abre al hacer clic en una fila de
// "Reportes guardados" (RetailerDetalle).
//
// La lista sólo alcanza a decir el archivo, quién lo subió y cuándo; aquí se
// contesta lo que viene después —qué trae dentro y cuánto suma— y se ofrece la
// única acción del reporte: borrarlo, para el archivo que no debió guardarse.
// Fuera de eso no hay filtros ni selección que mantener, así que pide sus datos
// al abrirse y no vuelve a tocar la red.
//
// Sin "use client": entra al bundle de cliente por ser importado desde
// RetailerDetalle, igual que el resto de los componentes del módulo.

import { ArrowLeft, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api, ClientApiError } from "@/components/lib/api-client";
import { fmtDec, fmtFecha, fmtFechaHora, fmtNum } from "@/components/lib/fmt";
import { AutorReporte, type UsuarioReporte } from "@/components/retail/AutorReporte";
import { Badge, Kpi, Panel } from "@/components/ui/basicos";
import { nombreRetailer } from "@/lib/retail/retailers";

interface Ficha {
  sourceFile: string;
  account: string;
  template: string;
  plantilla: string | null;
  filas: number;
  /** Filas que no comparte con ningún otro reporte: las que se irían al borrarlo. */
  exclusivas: number;
  articulos: number;
  marcasTotal: number;
  /** Periodo que cubren los datos, no las fechas de carga. */
  desde: string | null;
  hasta: string | null;
  importado: string | null;
  /** Null si el reporte no se ha vuelto a subir desde que se importó. */
  actualizado: string | null;
  subidoPor: UsuarioReporte | null;
  actualizadoPor: UsuarioReporte | null;
  metricas: { campo: string; nombre: string; total: number }[];
}

export function ReporteDetalle({
  account,
  sourceFile,
  onVolver,
  onBorrado,
}: {
  account: string;
  sourceFile: string;
  onVolver: () => void;
  /** Se llama cuando el reporte ya no está: el llamador recarga y vuelve. */
  onBorrado: () => void;
}) {
  const [ficha, setFicha] = useState<Ficha | null>(null);
  const [cargando, setCargando] = useState(true);
  // Borrar es irreversible, así que se pide confirmación en el mismo panel: un
  // window.confirm no puede decir cuántas filas se van.
  const [confirmando, setConfirmando] = useState(false);
  const [borrando, setBorrando] = useState(false);
  const [errorBorrado, setErrorBorrado] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    const q = new URLSearchParams({ account, sourceFile });
    try {
      setFicha(await api<Ficha>(`/api/retail/analisis/reporte?${q.toString()}`));
    } catch {
      setFicha(null);
    } finally {
      setCargando(false);
    }
  }, [account, sourceFile]);

  useEffect(() => {
    // fetch-on-mount: el flag de carga arranca activo
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void cargar();
  }, [cargar]);

  const borrar = useCallback(async () => {
    setBorrando(true);
    setErrorBorrado(null);
    const q = new URLSearchParams({ account, sourceFile });
    try {
      await api<{ borradas: number }>(`/api/retail/analisis/reporte?${q.toString()}`, {
        method: "DELETE",
      });
      onBorrado();
    } catch (error) {
      setBorrando(false);
      setConfirmando(false);
      setErrorBorrado(
        error instanceof ClientApiError
          ? `No se pudo borrar el reporte: ${error.message}`
          : "No se pudo borrar el reporte."
      );
    }
    // Sin `finally`: al borrar bien, este componente se desmonta y apagar el
    // spinner sería un setState sobre lo que ya no está en pantalla.
  }, [account, sourceFile, onBorrado]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="cr-btn cr-btn--secondary cr-btn--sm" onClick={onVolver}>
          <ArrowLeft strokeWidth={1.75} />
          Reportes
        </button>
        <span className="cr-mono min-w-0 flex-1 truncate" title={sourceFile}>
          {sourceFile}
        </span>
        {ficha?.plantilla ? <Badge tono="ok">{ficha.plantilla}</Badge> : null}
      </div>

      {cargando ? (
        <div className="flex flex-col gap-6" aria-busy="true">
          <div className="cr-panel cr-pulse" style={{ height: 96 }} />
          <div className="cr-panel cr-pulse" style={{ height: 240 }} />
        </div>
      ) : !ficha ? (
        <Panel>
          <p className="cr-body py-8 text-center">
            No se pudo cargar la información de este reporte. Vuelve a la lista y ábrelo otra
            vez para reintentar.
          </p>
        </Panel>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Kpi label="Filas" value={fmtNum(ficha.filas)} />
            <Kpi label="Productos" value={fmtNum(ficha.articulos)} />
            <Kpi label="Marcas" value={fmtNum(ficha.marcasTotal)} />
            <Kpi
              label="Periodo"
              value={
                <span className="cr-mono" style={{ fontSize: "15px" }}>
                  {fmtFecha(ficha.desde)} → {fmtFecha(ficha.hasta)}
                </span>
              }
            />
          </div>

          <Panel title="Procedencia">
            <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Dato etiqueta="Retailer">{nombreRetailer(ficha.account)}</Dato>
              <Dato etiqueta="Plantilla">{ficha.plantilla ?? ficha.template}</Dato>
              <Dato etiqueta="Archivo">
                <span className="cr-mono break-all">{ficha.sourceFile}</span>
              </Dato>
              <Dato etiqueta="Subido por">
                <AutorReporte usuario={ficha.subidoPor} />
              </Dato>
              <Dato etiqueta="Importado">
                <span className="cr-mono">{fmtFechaHora(ficha.importado)}</span>
              </Dato>
              <Dato etiqueta="Última actualización">
                {ficha.actualizado ? (
                  <>
                    <span className="cr-mono">{fmtFechaHora(ficha.actualizado)}</span>
                    {ficha.actualizadoPor ? (
                      <span className="cr-small block">
                        por {ficha.actualizadoPor.nombre}
                      </span>
                    ) : null}
                  </>
                ) : (
                  <span className="cr-small">Sin cambios desde que se importó</span>
                )}
              </Dato>
            </dl>
          </Panel>

          {ficha.metricas.length > 0 ? (
            <Panel title="Totales del reporte" sinPadding>
              <div className="cr-table-scroll">
                <table className="cr-table cr-table--head-lg">
                  <thead>
                    <tr>
                      <th>Columna</th>
                      <th className="num">Total</th>
                      <th className="num">Promedio por fila</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ficha.metricas.map((m) => (
                      <tr key={m.campo}>
                        <td>{m.nombre}</td>
                        <td className="num">{fmtNum(m.total)}</td>
                        <td className="num">
                          {ficha.filas > 0 ? fmtDec(m.total / ficha.filas) : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          ) : null}

          {/* Al final de la página y separado del resto: la salida para el
              archivo que no debió guardarse, no una acción más de la ficha. */}
          <Panel title="Borrar reporte">
            {/* Sin tope de ancho en el texto: cabe de sobra en una línea junto
                al botón, y `max-w-prose` (65ch) lo partía en dos. Si la pantalla
                se angosta de verdad, el flex-wrap lo baja entero. */}
            <div className="flex flex-wrap items-center justify-between gap-4">
              <p className="cr-body">
                <strong>Este cambio no se puede deshacer.</strong> Para recuperarlo hay que
                volver a subir el Excel.
              </p>

              {confirmando ? (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="cr-small" style={{ color: "var(--cr-danger)" }}>
                    ¿Borrar las {fmtNum(ficha.filas)} filas?
                  </span>
                  <button
                    type="button"
                    className="cr-btn cr-btn--danger cr-btn--sm"
                    disabled={borrando}
                    aria-busy={borrando}
                    onClick={() => void borrar()}
                  >
                    {borrando ? (
                      <>
                        <span className="cr-spin" aria-hidden="true" />
                        Borrando…
                      </>
                    ) : (
                      <>
                        <Trash2 strokeWidth={1.75} />
                        Sí, borrar
                      </>
                    )}
                  </button>
                  <button
                    type="button"
                    className="cr-btn cr-btn--ghost cr-btn--sm"
                    disabled={borrando}
                    onClick={() => setConfirmando(false)}
                  >
                    Cancelar
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  className="cr-btn cr-btn--danger cr-btn--sm"
                  onClick={() => setConfirmando(true)}
                >
                  <Trash2 strokeWidth={1.75} />
                  Borrar reporte
                </button>
              )}
            </div>

            {errorBorrado ? (
              <p
                className="cr-small mt-3"
                style={{ color: "var(--cr-danger)" }}
                role="alert"
              >
                {errorBorrado}
              </p>
            ) : null}
          </Panel>
        </>
      )}
    </div>
  );
}

function Dato({ etiqueta, children }: { etiqueta: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="cr-label">{etiqueta}</dt>
      <dd className="cr-body mt-1" style={{ color: "var(--cr-ink)" }}>
        {children}
      </dd>
    </div>
  );
}

