"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { Cargando } from "@/components/ui/Cargando";
import { BuscadorTabla } from "./BuscadorTabla";
import { Paginacion } from "@/components/dashboard/Paginacion";
import { normalizarBusqueda } from "@/lib/retail/analisis/filtrar";
import { api, ClientApiError } from "@/components/lib/api-client";
import { fmtDec, fmtFecha, fmtNum } from "@/components/lib/fmt";
import { Aviso, Badge } from "@/components/ui/basicos";
import { tonoEstatus } from "@/lib/catalogo/estatus";
import type { FichaProducto as Ficha } from "@/lib/catalogo/tipos";

/** Un dato de la ficha. Vacío se pinta "—", nunca en blanco. */
function Dato({ etiqueta, valor, mono }: { etiqueta: string; valor: string; mono?: boolean }) {
  return (
    <div className="cr-producto__dato">
      <span className="cr-small shrink-0">{etiqueta}</span>
      <span className={`text-right ${mono ? "cr-mono" : ""}`} title={valor || undefined}>
        {valor || "—"}
      </span>
    </div>
  );
}

function Seccion({ titulo, children }: { titulo: string; children: React.ReactNode }) {
  return (
    <section className="cr-producto__seccion">
      <h4 className="cr-label">{titulo}</h4>
      <div className="cr-producto__datos">
        {children}
      </div>
    </section>
  );
}

/**
 * Ficha de consulta sobre el listado. El diálogo conserva la página y los
 * filtros al cerrar; contiene el foco y permite consultar los canales de venta.
 */
export function FichaProducto({ item, onCerrar }: { item: string; onCerrar: () => void }) {
  const dialogo = useRef<HTMLDialogElement>(null);
  const [busqueda, setBusqueda] = useState("");
  const [pagina, setPagina] = useState(1);
  const [ficha, setFicha] = useState<Ficha | null>(null);
  const [error, setError] = useState<string | null>(null);

  const cargar = useCallback(async (clave: string) => {
    setFicha(null);
    setError(null);
    try {
      const r = await api<Ficha>(`/api/catalogo/producto?item=${encodeURIComponent(clave)}`);
      setFicha(r);
    } catch (e) {
      setError(
        e instanceof ClientApiError ? e.message : "No se pudo cargar la ficha del producto."
      );
    }
  }, []);

  useEffect(() => {
    // Al abrir y al cambiar de producto sin cerrar el cajón. Mismo patrón que
    // PeticionesAdmin: el setState llega dentro de la promesa, no en el cuerpo.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void cargar(item);
  }, [item, cargar]);

  // El diálogo nativo contiene el foco, vuelve al botón de origen y admite Escape.
  useEffect(() => {
    const el = dialogo.current;
    const previo = document.activeElement as HTMLElement | null;
    el?.showModal();
    return () => { el?.close(); previo?.focus(); };
  }, []);

  const termino = normalizarBusqueda(busqueda);
  const canales = (ficha?.mapeos ?? []).filter((m) => normalizarBusqueda(
    [m.channelName, m.channel, m.customerCode, m.ventas?.unidades, m.ventas?.importe].join(' ')
  ).includes(termino));
  const paginas = Math.max(1, Math.ceil(canales.length / 5));
  const paginaActual = Math.min(pagina, paginas);
  const p = ficha?.producto;

  return (
      <dialog ref={dialogo} className="cr-producto" aria-label={`Producto ${item}`}
        onCancel={(e) => { e.preventDefault(); onCerrar(); }}
        onClick={(e) => { if (e.target === e.currentTarget) { const r = e.currentTarget.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) onCerrar(); } }}>
      <div className="cr-producto__interior">
        <div className="cr-producto__head">
          <div className="min-w-0">
            <h3 className="cr-h3">{item}</h3>
            <div className="cr-small truncate" title={p?.description}>
              {p?.description ?? "Ficha de producto"}
            </div>
          </div>
          <button
            type="button"
            className="cr-btn cr-btn--ghost cr-btn--sm"
            onClick={onCerrar}
            aria-label="Cerrar ficha de producto" title="Cerrar ficha"
          >
            <X size={16} />
          </button>
        </div>

        <div className="cr-producto__cuerpo">
          {error ? (
            <Aviso tono="danger" titulo="No se pudo abrir el producto">
              {error}
            </Aviso>
          ) : !ficha || !p ? (
            <Cargando label="Cargando producto…" />
          ) : (
            <>
              <div className="cr-producto__grid">
              <Seccion titulo="Identificación">
                <Dato etiqueta="UPC" valor={p.upc} mono />
                <Dato etiqueta="Clave SAT" valor={p.satCode} mono />
                <Dato etiqueta="Fracción arancelaria" valor={p.tariffCode} mono />
                <Dato etiqueta="SUV" valor={p.suv} />
              </Seccion>

              <Seccion titulo="Comercial">
                <div className="cr-producto__dato">
                  <span className="cr-small shrink-0">ECOM</span>
                  <span>{p.ecom ? <Badge>{p.ecom}</Badge> : "—"}</span>
                </div>
                <div className="cr-producto__dato">
                  <span className="cr-small shrink-0">Trello</span>
                  <span>{p.trello ? <Badge>{p.trello}</Badge> : "—"}</span>
                </div>
                {/* Mismo badge y mismo tono que la columna Estatus de la tabla:
                    el dato tiene que leerse igual se mire donde se mire. */}
                <div className="cr-producto__dato">
                  <span className="cr-small shrink-0">Estatus</span>
                  <span>
                    {p.status ? <Badge tono={tonoEstatus(p.status)}>{p.status}</Badge> : "—"}
                  </span>
                </div>
                <Dato etiqueta="Línea" valor={p.line} />
                <Dato etiqueta="Unidad de venta" valor={p.salesUnit} />
              </Seccion>

              <Seccion titulo="Producto">
                <Dato
                  etiqueta="Gramaje"
                  valor={p.grammage === null ? "" : fmtDec(p.grammage)}
                  mono
                />
                <Dato
                  etiqueta="Meses de caducidad"
                  valor={p.shelfLifeMonths === null ? "" : fmtNum(p.shelfLifeMonths)}
                  mono
                />
                <Dato
                  etiqueta="Fecha de lanzamiento"
                  // Si no se pudo interpretar se muestra el texto del archivo:
                  // un hueco escondería que el dato venía.
                  valor={p.launchDate ? fmtFecha(p.launchDate) : p.launchDateText}
                  mono
                />
                <Dato etiqueta="Fila del Excel" valor={String(p.rowNumber)} mono />
              </Seccion>

              <Seccion titulo="Proveedores">
                {p.suppliers.length === 0 ? (
                  <Dato etiqueta="Proveedores" valor="" />
                ) : (
                  p.suppliers.map((s, i) => (
                    <Dato key={s} etiqueta={`Proveedor ${i + 1}`} valor={s} />
                  ))
                )}
              </Seccion>

              </div>
              <section className="cr-producto__ventas">
                <div className="cr-producto__ventas-head">
                <h4 className="cr-label">
                  Ventas por canal
                </h4>
                <BuscadorTabla busqueda={busqueda} onBusqueda={(v) => { setBusqueda(v); setPagina(1); }} placeholder="Buscar canal…" columnasBuscadas={["Canal", "Código", "Unidades", "Importe"]} />
                </div>

                {ficha.mapeos.length === 0 ? (
                  <p className="cr-body">
                    Este producto no tiene ningún código de cliente en el mapeo, así que no se
                    puede cruzar con las ventas.
                  </p>
                ) : (
                  <>
                    <div className="cr-producto__tabla">
                      <table className="cr-table cr-table--fija">
                        <thead>
                          <tr>
                            <th scope="col">Canal</th>
                            <th scope="col">Código</th>
                            <th scope="col" className="cr-num">
                              Unidades
                            </th>
                            <th scope="col" className="cr-num">
                              Importe
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {canales.slice((paginaActual - 1) * 5, paginaActual * 5).map((m) => {
                            // Tres estados distintos, y sólo el primero es un
                            // aviso: "no se puede cruzar" no es lo mismo que
                            // "se cruzó y no hay ventas".
                            const noCruza = !m.knownRetailer || m.customerCodeNum === null;
                            const motivo = !m.knownRetailer
                              ? "Este canal no es uno de los retailers del módulo, así que no hay reportes de venta suyos."
                              : "El código de cliente no es un número entero, así que no se puede cruzar con las ventas.";
                            return (
                              <tr key={m.channel}>
                                <td>
                                  {m.knownRetailer ? (
                                    <Badge>{m.channelName}</Badge>
                                  ) : (
                                    <Badge tono="warn">{m.channelName}</Badge>
                                  )}
                                </td>
                                <td className="cr-mono">{m.customerCode || "—"}</td>
                                {noCruza ? (
                                  <td colSpan={2} className="cr-small" title={motivo}>
                                    no cruza con ventas
                                  </td>
                                ) : (
                                  <>
                                    <td className="cr-num">
                                      {m.ventas ? fmtNum(m.ventas.unidades) : "—"}
                                    </td>
                                    <td className="cr-num">
                                      {m.ventas ? fmtDec(m.ventas.importe) : "—"}
                                    </td>
                                  </>
                                )}
                              </tr>
                            );
                          })}
                          {canales.length === 0 ? <tr><td colSpan={4}>No hay canales para esta búsqueda.</td></tr> : null}
                        </tbody>
                        {ficha.totales.canalesConVenta > 0 ? (
                          <tfoot>
                            <tr>
                              <td colSpan={2}>Total del producto</td>
                              <td className="cr-num">{fmtNum(ficha.totales.unidades)}</td>
                              <td className="cr-num">{fmtDec(ficha.totales.importe)}</td>
                            </tr>
                          </tfoot>
                        ) : null}
                      </table>
                    </div>
                    <Paginacion siempreVisible pagina={paginaActual} paginas={paginas} total={canales.length} porPagina={5} onCambiar={setPagina} sustantivo="canales" />

                    {ficha.totales.canalesConVenta === 0 ? (
                      <p className="cr-small">
                        Todavía no hay reportes de venta cargados para los canales de este
                        producto. Se cargan desde el módulo de Retail.
                      </p>
                    ) : null}
                  </>
                )}
              </section>
            </>
          )}
        </div>
        <footer className="cr-producto__pie"><button type="button" className="cr-btn cr-btn--secondary cr-btn--sm" onClick={onCerrar}>Cerrar ficha</button></footer>
      </div>
      </dialog>
  );
}
