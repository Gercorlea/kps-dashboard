"use client";

import { useCallback, useEffect, useState } from "react";
import { api, ClientApiError } from "@/components/lib/api-client";
import { fmtDec, fmtFecha, fmtNum } from "@/components/lib/fmt";
import { Aviso, Badge } from "@/components/ui/basicos";
import { tonoEstatus } from "@/lib/catalogo/estatus";
import type { FichaProducto as Ficha } from "@/lib/catalogo/tipos";

/** Un dato de la ficha. Vacío se pinta "—", nunca en blanco. */
function Dato({ etiqueta, valor, mono }: { etiqueta: string; valor: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <span className="cr-small shrink-0">{etiqueta}</span>
      <span className={`text-right ${mono ? "cr-mono" : ""}`} title={valor || undefined}>
        {valor || "—"}
      </span>
    </div>
  );
}

function Seccion({ titulo, children }: { titulo: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1">
      <h4 className="cr-small font-semibold tracking-wide uppercase">{titulo}</h4>
      <div className="flex flex-col divide-y" style={{ borderColor: "var(--cr-line-2)" }}>
        {children}
      </div>
    </section>
  );
}

function Esqueleto() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true">
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex flex-col gap-2">
          <div className="cr-skel" style={{ height: 12, width: "40%" }} />
          <div className="cr-skel" style={{ height: 32 }} />
          <div className="cr-skel" style={{ height: 32 }} />
        </div>
      ))}
    </div>
  );
}

/**
 * Cajón lateral con todo lo que la tabla no muestra, más las unidades vendidas
 * por cadena.
 *
 * Es el patrón `.cr-revision` de la bandeja de peticiones. Se elige cajón y no
 * página propia porque revisar productos es una tarea de recorrido: se abren
 * varios seguidos y no hay que perder el sitio en la tabla.
 */
export function FichaProducto({ item, onCerrar }: { item: string; onCerrar: () => void }) {
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

  // Escape cierra. PeticionesAdmin no lo tiene; es una mejora de este cajón, no
  // un cambio en el existente.
  useEffect(() => {
    const alTeclear = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCerrar();
    };
    window.addEventListener("keydown", alTeclear);
    return () => window.removeEventListener("keydown", alTeclear);
  }, [onCerrar]);

  const p = ficha?.producto;

  return (
    <>
      <div className="cr-backdrop" onClick={onCerrar} />
      <aside className="cr-revision" role="dialog" aria-modal="true" aria-label={`Producto ${item}`}>
        <div className="cr-revision__head">
          <div className="min-w-0">
            <h3 className="cr-h3 cr-mono">{item}</h3>
            <div className="cr-small truncate" title={p?.description}>
              {p?.description ?? "Cargando…"}
            </div>
          </div>
          <button
            type="button"
            className="cr-btn cr-btn--ghost cr-btn--sm"
            onClick={onCerrar}
          >
            Cerrar
          </button>
        </div>

        <div className="flex flex-col gap-5 p-4">
          {error ? (
            <Aviso tono="danger" titulo="No se pudo abrir el producto">
              {error}
            </Aviso>
          ) : !ficha || !p ? (
            <Esqueleto />
          ) : (
            <>
              <Seccion titulo="Identificación">
                <Dato etiqueta="UPC" valor={p.upc} mono />
                <Dato etiqueta="Clave SAT" valor={p.satCode} mono />
                <Dato etiqueta="Fracción arancelaria" valor={p.tariffCode} mono />
                <Dato etiqueta="SUV" valor={p.suv} />
              </Seccion>

              <Seccion titulo="Comercial">
                <div className="flex items-baseline justify-between gap-3 py-1">
                  <span className="cr-small shrink-0">ECOM</span>
                  <span>{p.ecom ? <Badge>{p.ecom}</Badge> : "—"}</span>
                </div>
                <div className="flex items-baseline justify-between gap-3 py-1">
                  <span className="cr-small shrink-0">Trello</span>
                  <span>{p.trello ? <Badge>{p.trello}</Badge> : "—"}</span>
                </div>
                {/* Mismo badge y mismo tono que la columna Estatus de la tabla:
                    el dato tiene que leerse igual se mire donde se mire. */}
                <div className="flex items-baseline justify-between gap-3 py-1">
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

              <section className="flex flex-col gap-2">
                <h4 className="cr-small font-semibold tracking-wide uppercase">
                  Unidades vendidas por canal
                </h4>

                {ficha.mapeos.length === 0 ? (
                  <p className="cr-body">
                    Este producto no tiene ningún código de cliente en el mapeo, así que no se
                    puede cruzar con las ventas.
                  </p>
                ) : (
                  <>
                    <div className="cr-table-scroll">
                      <table className="cr-table cr-table--compact">
                        <thead>
                          <tr>
                            <th scope="col">Canal</th>
                            <th scope="col">Código</th>
                            <th scope="col" className="num">
                              Unidades
                            </th>
                            <th scope="col" className="num">
                              Importe
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {ficha.mapeos.map((m) => {
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
                                    <td className="num">
                                      {m.ventas ? fmtNum(m.ventas.unidades) : "—"}
                                    </td>
                                    <td className="num">
                                      {m.ventas ? fmtDec(m.ventas.importe) : "—"}
                                    </td>
                                  </>
                                )}
                              </tr>
                            );
                          })}
                        </tbody>
                        {ficha.totales.canalesConVenta > 0 ? (
                          <tfoot>
                            <tr>
                              <td colSpan={2}>Total</td>
                              <td className="num">{fmtNum(ficha.totales.unidades)}</td>
                              <td className="num">{fmtDec(ficha.totales.importe)}</td>
                            </tr>
                          </tfoot>
                        ) : null}
                      </table>
                    </div>

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
      </aside>
    </>
  );
}
