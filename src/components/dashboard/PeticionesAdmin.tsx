"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, RotateCcw, X } from "lucide-react";
import { api, ClientApiError } from "@/components/lib/api-client";
import { Badge, Panel } from "@/components/ui/basicos";

// Bandeja de peticiones: facturas que llegaron por el portal y esperan decisión.
//
// CRITERIO DE LA PANTALLA: solo lo que cambia la decisión. Quien revisa necesita
// saber de quién es, cuánto es, contra qué orden va, si algo falla y qué queda
// pendiente. Todo lo demás —UUID, RFCs, claves de pago, tipo de comprobante—
// hace falta para auditar, no para decidir, y va plegado al final.

interface Fila {
  folio: string;
  tipo: string;
  estatus: string;
  cardCode: string;
  proveedor: string;
  total: string;
  moneda: string;
  ordenCompra: string | null;
  enviada: string | null;
  /** Fecha en que se archivó, o null si sigue en la bandeja. */
  archivada: string | null;
  motivoArchivo: string | null;
}

interface Validacion {
  regla: string;
  severidad: "BLOQUEANTE" | "ADVERTENCIA" | "INFO";
  pasa: boolean;
  detalle: string;
}

interface CoberturaLinea {
  lineNum: number;
  itemCode: string | null;
  description: string;
  ordenado: string;
  facturadoAntes: string;
  enEsta: string;
  restante: string;
  excedente: string;
}

interface Cobertura {
  lineas: CoberturaLinea[];
  estado: "SIN_FACTURAR" | "PARCIAL" | "COMPLETA" | "EXCEDE";
  sinCorrespondencia: { itemCode: string | null; description: string; quantity: string }[];
  lineasPendientes: number;
  totalOrden: number;
  monedaOrden: string;
}

interface Peticion extends Fila {
  uuid: string | null;
  rfcEmisor: string | null;
  rfcReceptor: string | null;
  subtotal: string;
  trasladados: string;
  entrada: string | null;
  xmlFileKey: string | null;
  pdfFileKey: string | null;
  evidencias: { title: string; description: string; fileKey: string }[];
}

interface Detalle {
  peticion: Peticion;
  cobertura: Cobertura | null;
  validaciones: Validacion[];
}

/**
 * Si se ensena el boton de pago simulado.
 *
 * Lleva `NEXT_PUBLIC_` porque esto es un componente de cliente y la bandera
 * tiene que llegar al navegador. Solo controla que el boton se VEA: quien
 * decide de verdad es la ruta, que responde 403 sin `FEATURE_PAGO_SIMULADO`.
 * Esconder un boton no es seguridad.
 */
const PAGO_SIMULADO = process.env.NEXT_PUBLIC_FEATURE_PAGO_SIMULADO === "true";


const ETIQUETA: Record<string, string> = {
  BORRADOR: "Borrador",
  EN_REVISION: "Por revisar",
  NC_EN_REVISION: "NC por revisar",
  EN_CORRECCION: "Devuelta",
  APROBADA_PAGO: "Aprobada",
  REGISTRADA_SAP: "Registrada en B1",
  CUENTAS_POR_PAGAR: "En cuentas por pagar",
  PAGADA: "Pagada",
  CERRADA: "Cerrada",
  RECHAZADA: "Rechazada",
  DUPLICADA: "Duplicada",
  ERROR_SAP: "Error de B1",
};

const TONO: Record<string, "ok" | "warn" | "danger" | undefined> = {
  EN_REVISION: "warn",
  NC_EN_REVISION: "warn",
  EN_CORRECCION: "warn",
  APROBADA_PAGO: "ok",
  PAGADA: "ok",
  CERRADA: "ok",
  RECHAZADA: "danger",
  DUPLICADA: "danger",
  ERROR_SAP: "danger",
};

function money(v: string, moneda: string): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return `${v} ${moneda}`;
  const f = new Intl.NumberFormat("es-MX", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
  return `${f} ${moneda}`;
}

/**
 * Compacta para comparar: sin acentos y sin nada que no sea letra o numero.
 *
 * La tabla pinta "OC 1098", asi que eso es lo que se copia al buscador. Sin
 * esto, buscar lo que se ve en pantalla no encontraria nada.
 */
function compacto(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toLowerCase();
}

function fecha(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${dd}/${mm} ${hh}:${mi}`;
}

type Filtro = "pendientes" | "todas" | "cerradas" | "archivadas";

const ETIQUETA_FILTRO: Record<Filtro, string> = {
  pendientes: "Pendientes",
  todas: "Todas",
  cerradas: "Cerradas",
  archivadas: "Archivadas",
};

export function PeticionesAdmin({ esAdmin }: { esAdmin: boolean }) {
  const [filas, setFilas] = useState<Fila[]>([]);
  const [pendientes, setPendientes] = useState(0);
  const [filtro, setFiltro] = useState<Filtro>("pendientes");
  const [busqueda, setBusqueda] = useState("");
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);

  const [abierta, setAbierta] = useState<Detalle | null>(null);
  const [motivo, setMotivo] = useState("");
  const [decidiendo, setDecidiendo] = useState(false);

  /** La fila cuyo archivado se está confirmando, y el folio que se está guardando. */
  const [porArchivar, setPorArchivar] = useState<Fila | null>(null);
  const [motivoArchivo, setMotivoArchivo] = useState("");
  const [archivando, setArchivando] = useState<string | null>(null);

  const cargar = useCallback(async (f: string) => {
    try {
      const q = f === "todas" ? "" : `?estatus=${f}`;
      const r = await api<{ pendientes: number; peticiones: Fila[] }>(`/api/peticiones${q}`);
      setFilas(r.peticiones);
      setPendientes(r.pendientes);
      setCargando(false);
    } catch (e) {
      setError(e instanceof ClientApiError ? e.message : "No se pudieron leer las peticiones");
      setCargando(false);
    }
  }, []);

  useEffect(() => {
    // Carga inicial y al cambiar de pestaña; `cargando` arranca en true.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void cargar(filtro);
  }, [cargar, filtro]);

  useEffect(() => {
    if (!abierta) return;
    function tecla(e: KeyboardEvent) {
      if (e.key === "Escape") setAbierta(null);
    }
    document.addEventListener("keydown", tecla);
    return () => document.removeEventListener("keydown", tecla);
  }, [abierta]);

  // Escape también cierra la confirmación de archivado: un diálogo del que solo
  // se sale con el ratón es el que acaba archivando lo que no se quería.
  useEffect(() => {
    if (!porArchivar) return;
    function tecla(e: KeyboardEvent) {
      if (e.key === "Escape") setPorArchivar(null);
    }
    document.addEventListener("keydown", tecla);
    return () => document.removeEventListener("keydown", tecla);
  }, [porArchivar]);

  async function abrir(folio: string) {
    setError(null);
    setMotivo("");
    try {
      setAbierta(await api<Detalle>(`/api/peticiones/${folio}`));
    } catch (e) {
      setError(e instanceof ClientApiError ? e.message : "No se pudo abrir la petición");
    }
  }

  async function decidir(decision: "aprobar" | "corregir" | "rechazar") {
    if (!abierta) return;
    setDecidiendo(true);
    setError(null);
    try {
      const r = await api<{ folio: string; estatus: string }>(
        `/api/peticiones/${abierta.peticion.folio}`,
        { method: "POST", body: JSON.stringify({ decision, motivo: motivo || undefined }) }
      );
      setAviso(`${r.folio}: ${ETIQUETA[r.estatus] ?? r.estatus}.`);
      setAbierta(null);
      await cargar(filtro);
    } catch (e) {
      setError(e instanceof ClientApiError ? e.message : "No se pudo registrar la decisión");
    } finally {
      setDecidiendo(false);
    }
  }

  /**
   * Paga la factura en Business One y la sincroniza. HERRAMIENTA DE PRUEBAS.
   *
   * NO ES TESORERIA. El pago real lo hace tesoreria dentro de B1, donde viven
   * las autorizaciones, la conciliacion bancaria y la segregacion de funciones
   * (§02: quien aprueba no paga). Esto existe para poder recorrer el ciclo
   * completo en pruebas sin depender de alguien con acceso a Business One.
   *
   * El boton solo aparece con `FEATURE_PAGO_SIMULADO=true`; sin la bandera la
   * ruta responde 403 aunque alguien la llame a mano.
   */
  async function pagarSimulado() {
    if (!abierta) return;
    setDecidiendo(true);
    setError(null);
    try {
      const r = await api<{
        folio: string;
        pago: { docNum: number; moneda: string; importe: number; cuenta: string };
        avisoSync: string | null;
      }>(`/api/peticiones/${abierta.peticion.folio}/pagar`, { method: "POST" });
      setAviso(
        `${r.folio}: pagada en Business One con el pago ${r.pago.docNum} · ${r.pago.moneda} ${r.pago.importe}` +
          (r.avisoSync ? ` (el pago entró, pero no se pudo sincronizar: ${r.avisoSync})` : "")
      );
      setAbierta(null);
      await cargar(filtro);
    } catch (e) {
      setError(e instanceof ClientApiError ? e.message : "No se pudo registrar el pago");
    } finally {
      setDecidiendo(false);
    }
  }

  /**
   * Archiva o restaura. Archivar pasa por un diálogo de confirmación —esconde
   * la petición de la vista de todos— y restaurar no: devolverla a la bandeja
   * no le quita nada a nadie, y pedir confirmación para deshacer convierte el
   * arreglo de un error en dos pasos.
   */
  async function archivar(fila: Fila, archivada: boolean, razon?: string) {
    setArchivando(fila.folio);
    setError(null);
    try {
      await api<{ folio: string; archivada: boolean }>(`/api/peticiones/${fila.folio}`, {
        method: "PATCH",
        body: JSON.stringify({ archivada, motivo: razon || undefined }),
      });
      setAviso(
        archivada
          ? `${fila.folio} archivada. Sigue completa en la base; está en la pestaña Archivadas.`
          : `${fila.folio} restaurada a la bandeja.`
      );
      setPorArchivar(null);
      setMotivoArchivo("");
      await cargar(filtro);
    } catch (e) {
      setError(
        e instanceof ClientApiError
          ? e.message
          : `No se pudo ${archivada ? "archivar" : "restaurar"} ${fila.folio}`
      );
    } finally {
      setArchivando(null);
    }
  }

  // Se filtra sobre lo ya cargado: son como mucho 200 filas y asi la busqueda es
  // instantanea, sin un viaje al servidor por cada tecla.
  const termino = compacto(busqueda);
  const visibles = termino
    ? filas.filter((f) =>
        [
          f.ordenCompra ?? "",
          f.ordenCompra ? `OC ${f.ordenCompra}` : "",
          f.proveedor,
          f.cardCode,
          f.folio,
        ].some((c) => compacto(c).includes(termino))
      )
    : filas;

  const bloqueantes =
    abierta?.validaciones.filter((v) => !v.pasa && v.severidad === "BLOQUEANTE") ?? [];

  return (
    <div className="cr-stack">
      <Panel
        title={`${pendientes} pendiente${pendientes === 1 ? "" : "s"}`}
        acciones={
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <input
              className="cr-input"
              style={{ width: 200 }}
              value={busqueda}
              onChange={(e) => setBusqueda(e.target.value)}
              placeholder="Filtrar por orden o proveedor"
              aria-label="Filtrar por orden o proveedor"
            />
            {/* "Archivadas" solo para quien puede archivar: al resto le sale
                siempre vacía, porque nadie más mueve nada ahí. */}
            {(esAdmin
              ? (["pendientes", "todas", "cerradas", "archivadas"] as const)
              : (["pendientes", "todas", "cerradas"] as const)
            ).map((f) => (
              <button
                key={f}
                type="button"
                className={`cr-btn cr-btn--sm ${filtro === f ? "cr-btn--primary" : "cr-btn--ghost"}`}
                onClick={() => {
                  setCargando(true);
                  setFiltro(f);
                }}
              >
                {ETIQUETA_FILTRO[f]}
              </button>
            ))}
          </div>
        }
        sinPadding
      >
        <div className="cr-table-scroll">
          <table className="cr-table">
            <thead>
              <tr>
                <th>Proveedor</th>
                <th>Orden</th>
                <th>Importe</th>
                {/* El estatus solo cuando puede variar: en Pendientes todas
                    dicen lo mismo y la columna no aporta nada. */}
                {filtro !== "pendientes" ? <th>Estatus</th> : null}
                <th>{filtro === "archivadas" ? "Archivada" : "Recibida"}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {cargando ? (
                <tr>
                  <td colSpan={6}>Cargando…</td>
                </tr>
              ) : visibles.length === 0 ? (
                <tr>
                  <td colSpan={6}>
                    {termino
                      ? `Ninguna petición coincide con "${busqueda}".`
                      : filtro === "pendientes"
                        ? "Todo al día: ninguna factura espera tu revisión."
                        : filtro === "archivadas"
                          ? "No has archivado ninguna petición."
                          : "No hay peticiones que mostrar."}
                  </td>
                </tr>
              ) : (
                visibles.map((f) => (
                  <tr key={f.folio}>
                    <td>
                      {f.proveedor}
                      <div className="cr-small">
                        {f.cardCode} · {f.folio}
                      </div>
                    </td>
                    <td>{f.ordenCompra ? `OC ${f.ordenCompra}` : "sin orden"}</td>
                    <td>{money(f.total, f.moneda)}</td>
                    {filtro !== "pendientes" ? (
                      <td>
                        <Badge tono={TONO[f.estatus]}>{ETIQUETA[f.estatus] ?? f.estatus}</Badge>
                      </td>
                    ) : null}
                    <td>
                      {fecha(f.archivada ?? f.enviada)}
                      {f.motivoArchivo ? (
                        <div className="cr-small" title={f.motivoArchivo}>
                          {f.motivoArchivo}
                        </div>
                      ) : null}
                    </td>
                    <td>
                      <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                        <button
                          type="button"
                          className="cr-btn cr-btn--primary cr-btn--sm"
                          onClick={() => void abrir(f.folio)}
                        >
                          Revisar
                        </button>
                        {esAdmin ? (
                          f.archivada ? (
                            <button
                              type="button"
                              className="cr-btn cr-btn--ghost cr-btn--sm"
                              disabled={archivando === f.folio}
                              onClick={() => void archivar(f, false)}
                            >
                              {archivando === f.folio ? "…" : "Restaurar"}
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="cr-btn cr-btn--ghost cr-btn--sm"
                              disabled={archivando === f.folio}
                              onClick={() => {
                                setMotivoArchivo("");
                                setPorArchivar(f);
                              }}
                            >
                              Archivar
                            </button>
                          )
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Panel>

      {error ? <p className="cr-error">{error}</p> : null}
      {aviso ? <p className="cr-small">{aviso}</p> : null}

      {/* Confirmación de archivado. Dice qué NO pasa —no se borra, se puede
          deshacer— porque el miedo a perder un CFDI es lo que hace que nadie
          use el botón y la bandeja acabe llena de ruido. */}
      {porArchivar ? (
        <div
          className="cr-confirmar"
          role="dialog"
          aria-modal="true"
          aria-label={`Archivar ${porArchivar.folio}`}
        >
          <div className="cr-confirmar__caja">
            <h3 style={{ margin: "0 0 8px" }}>Archivar {porArchivar.folio}</h3>
            <p className="cr-small" style={{ marginTop: 0 }}>
              {porArchivar.proveedor} · {money(porArchivar.total, porArchivar.moneda)} ·{" "}
              {ETIQUETA[porArchivar.estatus] ?? porArchivar.estatus}
            </p>
            <p>
              Sale de la bandeja, <strong>no se borra</strong>. La factura, sus archivos y su
              bitácora siguen intactos, y su estatus no cambia. La vas a encontrar en la pestaña
              Archivadas y puedes restaurarla cuando quieras.
            </p>
            {["EN_REVISION", "NC_EN_REVISION"].includes(porArchivar.estatus) ? (
              <p className="cr-small">
                Ojo: esta petición todavía espera decisión. Al archivarla deja de contar como
                pendiente y el proveedor se queda sin respuesta. Si lo que quieres es cerrarla,
                revísala y recházala con un motivo.
              </p>
            ) : null}

            <div className="cr-field" style={{ marginTop: 12 }}>
              <label className="cr-label" htmlFor="motivo-archivo">
                Motivo (opcional)
              </label>
              <input
                id="motivo-archivo"
                className="cr-input"
                value={motivoArchivo}
                onChange={(e) => setMotivoArchivo(e.target.value)}
                placeholder="Duplicada por error del proveedor"
                maxLength={500}
              />
            </div>

            <div style={{ display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap" }}>
              <button
                type="button"
                className="cr-btn cr-btn--primary"
                disabled={archivando === porArchivar.folio}
                onClick={() => void archivar(porArchivar, true, motivoArchivo)}
              >
                {archivando === porArchivar.folio ? "Archivando…" : "Archivar"}
              </button>
              <button
                type="button"
                className="cr-btn cr-btn--ghost"
                onClick={() => setPorArchivar(null)}
              >
                Cancelar
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {abierta ? (
        <>
          <div className="cr-backdrop" onClick={() => setAbierta(null)} />
          <aside className="cr-revision" role="dialog" aria-label="Revisar petición">
            <div className="cr-revision__head">
              <div>
                <h3 className="cr-h3">{abierta.peticion.proveedor}</h3>
                <div className="cr-small">
                  {money(abierta.peticion.total, abierta.peticion.moneda)}
                  {abierta.peticion.ordenCompra ? ` · OC ${abierta.peticion.ordenCompra}` : ""}
                </div>
              </div>
              <button
                type="button"
                className="cr-btn cr-btn--ghost cr-btn--sm"
                onClick={() => setAbierta(null)}
              >
                Cerrar
              </button>
            </div>
          {/* Fuera el resumen de lo normal: cuando todo cuadra, la tabla de
              abajo ya lo dice y la frase solo repetia. Se conservan los dos
              casos que SI cambian la decision y que la tabla no puede mostrar:
              facturar de mas, y no haber podido comprobarlo. */}
          {abierta.cobertura?.estado === "EXCEDE" ? (
            <p className="cr-error">
              Se factura POR ENCIMA de lo que pide la OC {abierta.peticion.ordenCompra}.
            </p>
          ) : !abierta.cobertura && abierta.peticion.ordenCompra ? (
            <p className="cr-error">
              No se pudo leer la OC {abierta.peticion.ordenCompra} en Business One: no se sabe
              cuánto falta. No es lo mismo que estar cubierta.
            </p>
          ) : null}

          {bloqueantes.length > 0 ? (
            <div>
              <p className="cr-error">Esta factura no pasó las validaciones del portal:</p>
              <ul className="cr-small">
                {bloqueantes.map((v) => (
                  <li key={v.regla}>{v.detalle}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {abierta.cobertura ? (
            <>
              <h4 className="cr-h3">Orden de compra contra factura</h4>
              <div className="cr-table-scroll">
                <table className="cr-table cr-comparativa">
                  <thead>
                    <tr>
                      <th>Concepto</th>
                      <th className="cr-num">Pide la orden</th>
                      <th className="cr-num">Trae el XML</th>
                      <th className="cr-num">Diferencia</th>
                    </tr>
                  </thead>
                  <tbody>
                    {abierta.cobertura.lineas.map((l) => {
                      // Lo ya facturado antes cuenta del lado del XML: la resta
                      // tiene que ser contra TODO lo facturado, no solo contra
                      // esta factura, o una orden a medias pareceria intacta.
                      const trae = Number(l.enEsta) + Number(l.facturadoAntes);
                      const falta = Number(l.restante);
                      const sobra = Number(l.excedente);
                      return (
                        <tr key={l.lineNum} data-diff={falta > 0 || sobra > 0 ? "si" : undefined}>
                          <td>
                            {l.itemCode ?? "—"}
                            <div className="cr-small">{l.description}</div>
                          </td>
                          <td className="cr-num">{l.ordenado}</td>
                          <td className="cr-num">
                            {l.enEsta}
                            {Number(l.facturadoAntes) > 0 ? (
                              <div className="cr-small">+{l.facturadoAntes} de antes</div>
                            ) : null}
                          </td>
                          <td className="cr-num">
                            {sobra > 0 ? (
                              <Badge tono="danger">sobran {l.excedente}</Badge>
                            ) : falta > 0 ? (
                              <Badge tono="warn">faltan {l.restante}</Badge>
                            ) : (
                              <Badge tono="ok">cubierta</Badge>
                            )}
                            {trae !== Number(l.ordenado) && falta === 0 && sobra === 0 ? null : null}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td>Importe con IVA</td>
                      <td className="cr-num">
                        {money(String(abierta.cobertura.totalOrden), abierta.cobertura.monedaOrden)}
                      </td>
                      <td className="cr-num">
                        {money(abierta.peticion.total, abierta.peticion.moneda)}
                      </td>
                      <td className="cr-num">
                        {money(
                          String(Number(abierta.peticion.total) - abierta.cobertura.totalOrden),
                          abierta.peticion.moneda
                        )}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </>
          ) : null}

          {abierta.cobertura && abierta.cobertura.sinCorrespondencia.length > 0 ? (
            <p className="cr-error">
              El CFDI trae conceptos que la orden no pidió:{" "}
              {abierta.cobertura.sinCorrespondencia
                .map((c) => `${c.itemCode ?? c.description} (${c.quantity})`)
                .join(", ")}
            </p>
          ) : null}

          {/* Los documentos van visibles y con nombre propio: quien revisa
              tiene que poder abrir el XML y la evidencia sin buscarlos. Antes
              vivian dentro del bloque plegado y no se encontraban. */}
          <h4 className="cr-h3">Documentos</h4>
          <div className="cr-docs">
            {abierta.peticion.xmlFileKey ? (
              <a
                className="cr-doc"
                href={`/api/proveedores/documentos/${abierta.peticion.xmlFileKey}`}
              >
                <span className="cr-doc__tipo">XML</span>
                <span>
                  CFDI timbrado
                  <span className="cr-small"> · el comprobante fiscal</span>
                </span>
              </a>
            ) : (
              <div className="cr-doc" data-falta="si">
                <span className="cr-doc__tipo">XML</span>
                <span>No lo subió</span>
              </div>
            )}

            {abierta.peticion.pdfFileKey ? (
              <a
                className="cr-doc"
                href={`/api/proveedores/documentos/${abierta.peticion.pdfFileKey}`}
              >
                <span className="cr-doc__tipo">PDF</span>
                <span>Representación impresa</span>
              </a>
            ) : (
              <div className="cr-doc" data-falta="si">
                <span className="cr-doc__tipo">PDF</span>
                <span>No lo subió</span>
              </div>
            )}

            {/* La evidencia lleva titulo y descripcion, no solo el archivo: sin
                ellos KPS no sabe que esta mirando. */}
            {abierta.peticion.evidencias.length === 0 ? (
              <div className="cr-doc" data-falta="si">
                <span className="cr-doc__tipo">EVID</span>
                <span>Sin evidencia</span>
              </div>
            ) : (
              abierta.peticion.evidencias.map((e) => (
                <a
                  key={e.fileKey}
                  className="cr-doc"
                  href={`/api/proveedores/documentos/${e.fileKey}`}
                >
                  <span className="cr-doc__tipo">EVID</span>
                  <span>
                    {e.title || "Evidencia"}
                    {e.description ? <span className="cr-small"> · {e.description}</span> : null}
                  </span>
                </a>
              ))
            )}
          </div>

          {/* Plegado: hace falta para auditar, no para decidir. */}
          <details className="cr-detalle-fiscal" open>
            <summary className="cr-small">Datos fiscales del CFDI</summary>
            <div className="cr-table-scroll">
              <table className="cr-table">
                <tbody>
                  <tr>
                    <td>Folio del portal</td>
                    <td>{abierta.peticion.folio}</td>
                  </tr>
                  <tr>
                    <td>UUID</td>
                    <td>{abierta.peticion.uuid || "—"}</td>
                  </tr>
                  <tr>
                    <td>RFC emisor</td>
                    <td>{abierta.peticion.rfcEmisor || "—"}</td>
                  </tr>
                  <tr>
                    <td>RFC receptor</td>
                    <td>{abierta.peticion.rfcReceptor || "—"}</td>
                  </tr>
                  <tr>
                    <td>Subtotal e IVA</td>
                    <td>
                      {money(abierta.peticion.subtotal, abierta.peticion.moneda)} +{" "}
                      {money(abierta.peticion.trasladados, abierta.peticion.moneda)}
                    </td>
                  </tr>
                  <tr>
                    <td>Entrada de mercancía</td>
                    <td>{abierta.peticion.entrada || "—"}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </details>

          {/* Pago simulado. Solo para facturas ya registradas en B1 y solo con la
              bandera de pruebas: en produccion no aparece y la ruta responde 403. */}
          {PAGO_SIMULADO &&
          ["REGISTRADA_SAP", "CUENTAS_POR_PAGAR"].includes(abierta.peticion.estatus) ? (
            <div className="cr-decision">
              <p className="cr-small">
                Herramienta de pruebas: crea el pago en Business One y marca la factura como
                pagada. En la operación real lo hace tesorería dentro de Business One.
              </p>
              <div className="cr-decision__botones">
                <button
                  type="button"
                  className="cr-btn cr-btn--primary"
                  onClick={() => void pagarSimulado()}
                  disabled={decidiendo}
                >
                  <Check size={14} strokeWidth={1.75} /> Simular pago
                </button>
              </div>
            </div>
          ) : null}

          <div className="cr-decision">
            <div className="cr-field">
              <label className="cr-label" htmlFor="motivo">
                Motivo
              </label>
              <input
                id="motivo"
                className="cr-input"
                value={motivo}
                onChange={(e) => setMotivo(e.target.value)}
                placeholder="Qué tiene que corregir el proveedor"
              />
              <p className="cr-small">Obligatorio para devolver o rechazar.</p>
            </div>

            <div className="cr-decision__botones">
            <button
              type="button"
              className="cr-btn cr-btn--primary"
              onClick={() => void decidir("aprobar")}
              disabled={decidiendo}
            >
              <Check size={14} strokeWidth={1.75} /> Aprobar para pago
            </button>
            <button
              type="button"
              className="cr-btn cr-btn--secondary"
              onClick={() => void decidir("corregir")}
              disabled={decidiendo || !motivo.trim()}
              title={motivo.trim() ? undefined : "Escribe el motivo para devolverla"}
            >
              <RotateCcw size={14} strokeWidth={1.75} /> Devolver
            </button>
            <button
              type="button"
              className="cr-btn cr-btn--danger"
              onClick={() => void decidir("rechazar")}
              disabled={decidiendo || !motivo.trim()}
              title={motivo.trim() ? undefined : "Escribe el motivo del rechazo"}
            >
                <X size={14} strokeWidth={1.75} /> Rechazar
              </button>
            </div>
          </div>
          </aside>
        </>
      ) : null}
    </div>
  );
}
