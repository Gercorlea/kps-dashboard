// Ficha de un reporte guardado: lo que se abre al hacer clic en una fila de
// "Reportes guardados" (RetailerDetalle).
//
// La lista sólo alcanza a decir el archivo, quién lo subió y cuándo; aquí se
// contesta lo que viene después —qué trae dentro, cuánto suma y quién ha escrito
// en él—. Es una vista de lectura: no hay filtros ni selección que mantener, así
// que pide sus datos al abrirse y no vuelve a tocar la red.
//
// Sin "use client": entra al bundle de cliente por ser importado desde
// RetailerDetalle, igual que el resto de los componentes del módulo.

import { ArrowLeft } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/components/lib/api-client";
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
  articulos: number;
  marcas: string[];
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
  autores: { usuario: UsuarioReporte | null; filas: number; desde: string; hasta: string }[];
}

export function ReporteDetalle({
  account,
  sourceFile,
  onVolver,
}: {
  account: string;
  sourceFile: string;
  onVolver: () => void;
}) {
  const [ficha, setFicha] = useState<Ficha | null>(null);
  const [cargando, setCargando] = useState(true);

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
            <Kpi label="Artículos" value={fmtNum(ficha.articulos)} />
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
                <table className="cr-table">
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
              {/* Sumar una columna que ya es un promedio (Avg Price) no
                  significa nada; se muestran las dos lecturas en vez de elegir
                  una que engañe en la mitad de las filas. */}
              <div className="cr-panel__body">
                <p className="cr-small">
                  El promedio es por fila del reporte: es la lectura que tiene sentido en las
                  columnas que ya vienen promediadas, donde el total no.
                </p>
              </div>
            </Panel>
          ) : null}

          {ficha.marcas.length > 0 ? (
            <Panel title="Marcas">
              <div className="flex flex-wrap gap-2">
                {ficha.marcas.map((m) => (
                  <Badge key={m}>{m}</Badge>
                ))}
                {ficha.marcasTotal > ficha.marcas.length ? (
                  <span className="cr-small">
                    y {fmtNum(ficha.marcasTotal - ficha.marcas.length)} más
                  </span>
                ) : null}
              </div>
            </Panel>
          ) : null}

          <Panel title="Quién escribió estas filas" sinPadding>
            <div className="cr-table-scroll">
              <table className="cr-table">
                <thead>
                  <tr>
                    <th>Usuario</th>
                    <th className="num">Filas</th>
                    <th>Primera escritura</th>
                    <th>Última escritura</th>
                  </tr>
                </thead>
                <tbody>
                  {ficha.autores.map((a, i) => (
                    <tr key={a.usuario?.id ?? `sin-usuario-${i}`}>
                      <td>
                        <AutorReporte usuario={a.usuario} />
                      </td>
                      <td className="num">{fmtNum(a.filas)}</td>
                      <td className="cr-mono">{fmtFechaHora(a.desde)}</td>
                      <td className="cr-mono">{fmtFechaHora(a.hasta)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="cr-panel__body">
              <p className="cr-small">
                Cada fila cuenta según la última carga que la escribió: al volver a subir el
                reporte, sus filas pasan a nombre de quien lo subió esa vez.
              </p>
            </div>
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

