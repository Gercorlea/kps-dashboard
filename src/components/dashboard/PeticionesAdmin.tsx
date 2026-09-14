"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { BellRing, Check, Download, Pause, RotateCcw, Search, Send, Sparkles, X } from "lucide-react";
import { Paginacion } from "@/components/dashboard/Paginacion";
import { api, ClientApiError, fetchConSesion } from "@/components/lib/api-client";
import { useFilasQueCaben } from "@/components/lib/useFilasQueCaben";
import { Aviso, Badge, Campo, EstadoVacio, Panel, Tabla } from "@/components/ui/basicos";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";

// Bandeja de peticiones: facturas que llegaron por el portal y esperan decisión.
//
// CRITERIO DE LA PANTALLA: solo lo que cambia la decisión. Quien revisa necesita
// saber de quién es, cuánto es, contra qué orden va, si algo falla y qué queda
// pendiente. Todo lo demás —UUID, RFCs, claves de pago, tipo de comprobante—
// hace falta para auditar, no para decidir, y va plegado al final.
//
// LA REVISIÓN VA EN PANEL LATERAL, NO EN MAESTRO-DETALLE. La comparación contra
// la orden de compra es una tabla de cuatro columnas, más validaciones,
// documentos y datos fiscales: no cabe en la columna de 380px que usa el
// maestro-detalle. Y a diferencia del alta de proveedores, aquí no se captura en
// serie —se revisa una y se decide—, así que el coste de abrir y cerrar no pesa.

interface Fila {
  folio: string;
  tipo: string;
  estatus: string;
  cardCode: string;
  proveedor: string;
  total: string;
  moneda: string;
  ordenCompra: string | null;
  entrada: string | null;
  enviada: string | null;
  /** Fecha en que se archivó, o null si sigue en la bandeja. */
  archivada: string | null;
  motivoArchivo: string | null;
  enEspera: boolean;
  credito: EstadoCredito;
}

interface EstadoCredito {
  inicio: string | null;
  vencimiento: string | null;
  dias: number | null;
  diasRestantes: number | null;
  vencida: boolean;
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

interface Cotejo {
  summary: string;
  canProceed: boolean;
  receiptTotal: string;
  invoiceTotal: string;
  ranAt?: string;
  lineas?: Array<{
    descripcion: string;
    cantidadPedida: string | null;
    cantidadRecibida: string | null;
    cantidadFacturada: string | null;
    importeRecibido: string | null;
    importeFacturado: string | null;
    diferencia: string | null;
  }>;
}

interface ResultadoDecision {
  folio: string;
  estatus: string;
  sap?: { registrada: boolean; docNum?: number; detalle?: string; avisoAdjuntos?: string | null };
  enEspera?: boolean;
}

interface Peticion extends Fila {
  serie: string | null;
  folioFiscal: string | null;
  fechaEmision: string | null;
  retenidos: string;
  metodoPago: string | null;
  formaPago: string | null;
  comentarioProveedor: string | null;
  sapDocNum: number | null;
  sapError: string | null;
  uuid: string | null;
  rfcEmisor: string | null;
  rfcReceptor: string | null;
  subtotal: string;
  trasladados: string;
  entrada: string | null;
  xmlFileKey: string | null;
  pdfFileKey: string | null;
  evidencias: { title: string; description: string; fileKey: string }[];
  esperaDesde: string | null;
  pago: {
    comprobanteFileKey: string | null;
    comprobanteCargadoEl: string | null;
    complementoEstatus: "NO_HABILITADO" | "PENDIENTE" | "RECIBIDO";
    complementoLimite: string | null;
    complementoXmlFileKey: string | null;
    complementoPdfFileKey: string | null;
  };
}

interface Detalle {
  peticion: Peticion;
  cobertura: Cobertura | null;
  cotejo: Cotejo | null;
  bitacora: Array<{ de: string | null; a: string; comentario: string | null; cuando: string | null }>;
  validaciones: Validacion[];
  polizaPrevia: {
    etapa: "VALIDACION_PREVIA";
    importe: string;
    moneda: string;
    movimientos: Array<{ tipo: "CARGO" | "ABONO"; cuenta: string; descripcion: string }>;
  };
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
 * Solo la cifra, sin la moneda.
 *
 * En la comparativa las tres columnas de importe son de la MISMA moneda, y
 * repetir "USD" en cada celda gastaba el ancho que necesitaban los números:
 * "630,000.00 USD" contra "630,000.00 USD" acababan pegados. La moneda se dice
 * una vez, en la etiqueta de la fila.
 */
function cifra(v: string | number): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  return new Intl.NumberFormat("es-MX", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
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

function textoCredito(credito: EstadoCredito): string {
  if (!credito.inicio) return "Inicia al liberar";
  if (credito.diasRestantes === null) return "Plazo sin configurar";
  if (credito.diasRestantes < 0) return `${Math.abs(credito.diasRestantes)} d vencida`;
  if (credito.diasRestantes === 0) return "Vence hoy";
  return `${credito.diasRestantes} d restantes`;
}

type Filtro = "pendientes" | "todas" | "cerradas" | "archivadas";

const ETIQUETA_FILTRO: Record<Filtro, string> = {
  pendientes: "Pendientes",
  todas: "Todas",
  cerradas: "Cerradas",
  archivadas: "Archivadas",
};

/** Alto de una fila a densidad compacta con un botón dentro. */
const ALTO_FILA = 41;

/**
 * Una fila de la lista de documentos.
 *
 * Presente y ausente comparten la MISMA fila —mismo alto, mismo chip, misma
 * posición— y solo cambia la tinta y el icono de abrir. Antes eran dos bloques
 * distintos y lo que faltaba pesaba visualmente igual que lo que estaba, con la
 * ventaja de que ni siquiera se podía barrer la columna de un vistazo.
 */
function Documento({
  tipo,
  fileKey,
  nombre,
  nota,
}: {
  tipo: string;
  fileKey: string | null;
  nombre: string;
  nota?: string;
}) {
  const cuerpo = (
    <>
      <span className="cr-doc__tipo">{tipo}</span>
      <span className="cr-doc__nombre truncate" title={nota ? `${nombre} · ${nota}` : nombre}>
        {fileKey ? nombre : "No lo subió"}
        {fileKey && nota ? <span className="cr-small"> · {nota}</span> : null}
      </span>
    </>
  );

  if (!fileKey) {
    return (
      <div className="cr-doc" data-falta="si">
        {cuerpo}
      </div>
    );
  }
  return (
    <a className="cr-doc" href={`/api/proveedores/documentos/${fileKey}`}>
      {cuerpo}
      <span className="cr-doc__abrir" aria-hidden="true">
        <Download strokeWidth={1.75} />
      </span>
    </a>
  );
}

export function PeticionesAdmin({ esAdmin }: { esAdmin: boolean }) {
  const [filas, setFilas] = useState<Fila[]>([]);
  const [pendientes, setPendientes] = useState(0);
  const [filtro, setFiltro] = useState<Filtro>("pendientes");
  const [busqueda, setBusqueda] = useState("");
  const [pagina, setPagina] = useState(1);
  const [cargando, setCargando] = useState(true);
  // `error` es solo el fallo de CARGA: deja la pantalla sin datos y necesita
  // decir qué hacer. Los acuses de decisión van por toast.
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  const [abierta, setAbierta] = useState<Detalle | null>(null);
  const [motivo, setMotivo] = useState("");
  const [decidiendo, setDecidiendo] = useState(false);
  const [enviandoDispersion, setEnviandoDispersion] = useState(false);
  const [descargandoDispersion, setDescargandoDispersion] = useState(false);
  const [enviandoAlertas, setEnviandoAlertas] = useState(false);
  const [subiendoComprobante, setSubiendoComprobante] = useState(false);
  const [analizandoSello, setAnalizandoSello] = useState(false);

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

  // Se filtra sobre lo ya cargado: son como mucho 200 filas y asi la busqueda es
  // instantanea, sin un viaje al servidor por cada tecla.
  const termino = compacto(busqueda);
  const visibles = useMemo(
    () =>
      termino
        ? filas.filter((f) =>
            [
              f.entrada ?? "",
              f.entrada ? `Entrada ${f.entrada}` : "",
              f.ordenCompra ?? "",
              f.ordenCompra ? `OC ${f.ordenCompra}` : "",
              f.proveedor,
              f.cardCode,
              f.folio,
              ETIQUETA[f.estatus] ?? f.estatus,
            ].some((c) => compacto(c).includes(termino))
          )
        : filas,
    [filas, termino]
  );

  // Paginación calculada: la lista nunca lleva scroll propio ni obliga a bajar
  // la página para llegar al pie.
  const { ancla, filas: porPagina } = useFilasQueCaben({
    altoFila: ALTO_FILA,
    recalcularCon: [visibles.length, cargando],
  });
  const tamano = porPagina ?? 10;
  const paginas = Math.max(1, Math.ceil(visibles.length / tamano));
  // Si el filtro o la búsqueda dejan menos páginas de las que había, la página
  // actual puede quedar fuera de rango: se sujeta al pintar en vez de arrastrar
  // un estado imposible.
  const paginaActual = Math.min(pagina, paginas);
  const ordenadas = [...visibles].sort((a, b) =>
    a.proveedor.localeCompare(b.proveedor, "es-MX") ||
    (a.enviada ?? "").localeCompare(b.enviada ?? "")
  );
  const enPagina = ordenadas.slice((paginaActual - 1) * tamano, paginaActual * tamano);
  const gruposPagina = enPagina.reduce<Array<{
    clave: string;
    proveedor: string;
    cardCode: string;
    filas: Fila[];
    vencido: number;
    moneda: string;
  }>>((salida, fila) => {
    let grupo = salida.at(-1);
    if (!grupo || grupo.clave !== fila.cardCode) {
      grupo = {
        clave: fila.cardCode,
        proveedor: fila.proveedor,
        cardCode: fila.cardCode,
        filas: [],
        vencido: 0,
        moneda: fila.moneda,
      };
      salida.push(grupo);
    }
    grupo.filas.push(fila);
    if (fila.credito.vencida && fila.moneda === grupo.moneda) {
      grupo.vencido += Number(fila.total) || 0;
    }
    return salida;
  }, []);

  function cambiarFiltro(f: Filtro) {
    setCargando(true);
    setFiltro(f);
    setPagina(1);
  }

  async function abrir(folio: string) {
    setMotivo("");
    try {
      setAbierta(await api<Detalle>(`/api/peticiones/${folio}`));
    } catch (e) {
      toast.error(
        "No se pudo abrir la petición",
        e instanceof ClientApiError ? e.message : undefined
      );
    }
  }

  async function reintentarSap() {
    if (!abierta) return;
    setDecidiendo(true);
    try {
      const r = await api<ResultadoDecision>(`/api/peticiones/${abierta.peticion.folio}`, {
        method: "PUT",
      });
      toast.ok(
        r.sap?.registrada ? `${r.folio} · registrada en SAP` : `${r.folio} · registro pendiente`,
        r.sap?.registrada
          ? `Factura SAP ${r.sap.docNum ?? "—"}.${r.sap.avisoAdjuntos ? ` ${r.sap.avisoAdjuntos}` : ""}`
          : r.sap?.detalle
      );
      await abrir(abierta.peticion.folio);
      await cargar(filtro);
    } catch (e) {
      toast.error("No se pudo reintentar el registro", e instanceof ClientApiError ? e.message : undefined);
    } finally {
      setDecidiendo(false);
    }
  }

  async function decidir(decision: "aprobar" | "esperar" | "corregir" | "rechazar") {
    if (!abierta) return;
    setDecidiendo(true);
    try {
      const r = await api<ResultadoDecision>(
        `/api/peticiones/${abierta.peticion.folio}`,
        { method: "POST", body: JSON.stringify({ decision, motivo: motivo || undefined }) }
      );
      const detalleSap = r.sap?.registrada === false
        ? `Registro en SAP pendiente: ${r.sap.detalle ?? "reintenta desde la petición"}.`
        : r.sap?.docNum
          ? `Factura SAP ${r.sap.docNum}.`
          : "";
      toast.ok(
        `${r.folio} · ${r.enEspera ? "En espera" : ETIQUETA[r.estatus] ?? r.estatus}`,
        `${abierta.peticion.proveedor}${detalleSap ? ` · ${detalleSap}` : ""}${r.sap?.avisoAdjuntos ? ` ${r.sap.avisoAdjuntos}` : ""}`
      );
      setAbierta(null);
      await cargar(filtro);
    } catch (e) {
      toast.error(
        "No se pudo registrar la decisión",
        e instanceof ClientApiError ? e.message : undefined
      );
    } finally {
      setDecidiendo(false);
    }
  }

  async function enviarDispersion() {
    setEnviandoDispersion(true);
    try {
      const r = await api<{ enviadas: number; destino: string }>("/api/peticiones/dispersion", {
        method: "POST",
      });
      toast.ok("Dispersión enviada", `${r.enviadas} pago(s) enviados a ${r.destino}.`);
      await cargar(filtro);
    } catch (e) {
      toast.error("No se pudo enviar la dispersión", e instanceof ClientApiError ? e.message : undefined);
    } finally {
      setEnviandoDispersion(false);
    }
  }

  async function descargarDispersion() {
    setDescargandoDispersion(true);
    try {
      const res = await fetchConSesion("/api/peticiones/dispersion");
      if (!res.ok) {
        const cuerpo = await res.json().catch(() => null) as { error?: { message?: string } } | null;
        throw new Error(cuerpo?.error?.message ?? "No se pudo generar el Excel");
      }
      const href = URL.createObjectURL(await res.blob());
      const enlace = document.createElement("a");
      enlace.href = href;
      enlace.download = `dispersion-kps-${new Date().toISOString().slice(0, 10)}.xlsx`;
      enlace.click();
      URL.revokeObjectURL(href);
    } catch (e) {
      toast.error("No se pudo generar el Excel", e instanceof Error ? e.message : undefined);
    } finally {
      setDescargandoDispersion(false);
    }
  }

  async function enviarAlertas() {
    setEnviandoAlertas(true);
    try {
      const r = await api<{ pendientes: number; escaladas: number; faltaDestinoEscalamiento?: boolean }>(
        "/api/peticiones/alertas",
        { method: "POST" }
      );
      toast.ok(
        "Alertas enviadas",
        `${r.pendientes} factura(s); ${r.escaladas} escalada(s).${r.faltaDestinoEscalamiento ? " Falta configurar el correo de contabilidad." : ""}`
      );
    } catch (e) {
      toast.error("No se pudieron enviar las alertas", e instanceof ClientApiError ? e.message : undefined);
    } finally {
      setEnviandoAlertas(false);
    }
  }

  async function subirComprobante(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!abierta) return;
    setSubiendoComprobante(true);
    try {
      const r = await api<{ complementoLimite: string }>(
        `/api/peticiones/${abierta.peticion.folio}/comprobante`,
        { method: "POST", body: new FormData(e.currentTarget) }
      );
      toast.ok("Comprobante guardado", `El complemento vence ${fecha(r.complementoLimite)}.`);
      await abrir(abierta.peticion.folio);
    } catch (e) {
      toast.error("No se pudo cargar el comprobante", e instanceof ClientApiError ? e.message : undefined);
    } finally {
      setSubiendoComprobante(false);
    }
  }

  async function analizarSello() {
    if (!abierta) return;
    setAnalizandoSello(true);
    try {
      const r = await api<{ selloEncontrado: boolean; confianza: number; firmaAlmacenEncontrada: boolean }>(
        `/api/peticiones/${abierta.peticion.folio}/sello`,
        { method: "POST" }
      );
      toast.ok(
        r.selloEncontrado ? "Sello detectado" : "Sello no detectado",
        `${Math.round(r.confianza * 100)}% de confianza · ${r.firmaAlmacenEncontrada ? "firma detectada" : "firma no detectada"}`
      );
      await abrir(abierta.peticion.folio);
    } catch (e) {
      toast.error("No se pudo analizar el sello", e instanceof ClientApiError ? e.message : undefined);
    } finally {
      setAnalizandoSello(false);
    }
  }

  /**
   * Paga la factura en Business One y la sincroniza. HERRAMIENTA DE PRUEBAS.
   *
   * NO ES TESORERIA. El pago real lo hace tesoreria dentro de B1, donde viven
   * las autorizaciones, la conciliacion bancaria y la segregacion de funciones
   * (§02: quien aprueba no paga). Esto existe para poder recorrer el ciclo
   * completo en pruebas sin depender de alguien con acceso a Business One.
   */
  async function pagarSimulado() {
    if (!abierta) return;
    setDecidiendo(true);
    try {
      const r = await api<{
        folio: string;
        pago: { docNum: number; moneda: string; importe: number; cuenta: string };
        avisoSync: string | null;
      }>(`/api/peticiones/${abierta.peticion.folio}/pagar`, { method: "POST" });
      toast.ok(
        `${r.folio} pagada en Business One`,
        `Pago ${r.pago.docNum} · ${r.pago.moneda} ${r.pago.importe}` +
          (r.avisoSync ? ` (el pago entró, pero no se pudo sincronizar: ${r.avisoSync})` : "")
      );
      setAbierta(null);
      await cargar(filtro);
    } catch (e) {
      toast.error(
        "No se pudo registrar el pago",
        e instanceof ClientApiError ? e.message : undefined
      );
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
    try {
      await api<{ folio: string; archivada: boolean }>(`/api/peticiones/${fila.folio}`, {
        method: "PATCH",
        body: JSON.stringify({ archivada, motivo: razon || undefined }),
      });
      if (archivada) {
        toast.ok(`${fila.folio} archivada`, "Sigue completa en la base, en la pestaña Archivadas.");
      } else {
        toast.ok(`${fila.folio} restaurada a la bandeja`);
      }
      setPorArchivar(null);
      setMotivoArchivo("");
      await cargar(filtro);
    } catch (e) {
      toast.error(
        `No se pudo ${archivada ? "archivar" : "restaurar"} ${fila.folio}`,
        e instanceof ClientApiError ? e.message : undefined
      );
    } finally {
      setArchivando(null);
    }
  }

  const bloqueantes =
    abierta?.validaciones.filter((v) => !v.pasa && v.severidad === "BLOQUEANTE") ?? [];
  const selloAprobado =
    abierta?.validaciones.some((v) => v.regla === "SELLO_ALMACEN" && v.pasa) ?? false;

  const pestanas: Filtro[] = esAdmin
    ? ["pendientes", "todas", "cerradas", "archivadas"]
    : ["pendientes", "todas", "cerradas"];

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
          placeholder="Orden, entrada, proveedor o folio"
          aria-label="Filtrar por orden, entrada, proveedor o folio"
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
      <button
        type="button"
        className="cr-btn cr-btn--secondary cr-btn--sm"
        disabled={descargandoDispersion}
        onClick={() => void descargarDispersion()}
      >
        <Download strokeWidth={1.75} /> {descargandoDispersion ? "Generando…" : "Excel"}
      </button>
      <button
        type="button"
        className="cr-btn cr-btn--secondary cr-btn--sm"
        disabled={enviandoDispersion}
        onClick={() => void enviarDispersion()}
      >
        <Send strokeWidth={1.75} /> {enviandoDispersion ? "Enviando…" : "Enviar a tesorería"}
      </button>
      <button
        type="button"
        className="cr-btn cr-btn--secondary cr-btn--sm"
        disabled={enviandoAlertas}
        onClick={() => void enviarAlertas()}
      >
        <BellRing strokeWidth={1.75} /> {enviandoAlertas ? "Enviando…" : "Alertar pendientes"}
      </button>
      {/* Segmentado y no cuatro botones sueltos: son vistas excluyentes de la
          misma lista, y con botones el activo se leía como una acción. */}
      <div className="cr-segment">
        {pestanas.map((f) => (
          <button
            key={f}
            type="button"
            className={`cr-segment__item${filtro === f ? " cr-segment__item--active" : ""}`}
            onClick={() => cambiarFiltro(f)}
          >
            {ETIQUETA_FILTRO[f]}
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <>
      {error ? (
        <Aviso tono="danger" titulo="No se pudieron leer las peticiones">
          {error}
        </Aviso>
      ) : null}

      <Panel
        title="Bandeja"
        subtitulo={
          termino
            ? `${visibles.length} de ${filas.length} · ${pendientes} pendiente${pendientes === 1 ? "" : "s"} en total`
            : `${pendientes} pendiente${pendientes === 1 ? "" : "s"}`
        }
        acciones={controles}
        sinPadding
      >
        <div ref={ancla} aria-busy={cargando}>
          {cargando ? (
            <p className="cr-body px-[18px] py-16 text-center">Leyendo la bandeja…</p>
          ) : visibles.length === 0 ? (
            <EstadoVacio
              title={
                termino
                  ? "No hay resultados para esa búsqueda"
                  : filtro === "pendientes"
                    ? "Todo al día"
                    : filtro === "archivadas"
                      ? "No has archivado ninguna petición"
                      : "No hay peticiones que mostrar"
              }
              detalle={
                termino
                  ? `Ninguna petición coincide con "${busqueda}".`
                  : filtro === "pendientes"
                    ? "Ninguna factura espera tu revisión."
                    : undefined
              }
            />
          ) : (
            <Tabla densidad="compacta" fija>
              <colgroup>
                <col />
                {/* 124 y no 96: "FAC-2026-012" en mono mide ~86px y con el
                    padding de la celda llenaba la columna entera, así que el
                    folio quedaba pegado a la orden de la columna siguiente. */}
                <col style={{ width: 124 }} />
                <col style={{ width: 104 }} />
                <col style={{ width: 148 }} />
                <col style={{ width: 124 }} />
                {filtro !== "pendientes" ? <col style={{ width: 132 }} /> : null}
                <col style={{ width: 104 }} />
                <col style={{ width: esAdmin ? 176 : 96 }} />
              </colgroup>
              <thead>
                <tr>
                  <th>Proveedor</th>
                  <th>Folio</th>
                  <th>Orden</th>
                  <th className="cr-num">Importe</th>
                  <th>Crédito</th>
                  {/* El estatus solo cuando puede variar: en Pendientes todas
                      dicen lo mismo y la columna no aporta nada. */}
                  {filtro !== "pendientes" ? <th>Estatus</th> : null}
                  <th>{filtro === "archivadas" ? "Archivada" : "Recibida"}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {gruposPagina.map((grupo) => (
                  <Fragment key={grupo.clave}>
                    <tr className="cr-grupo-proveedor">
                      <td colSpan={filtro !== "pendientes" ? 8 : 7}>
                        <strong>{grupo.proveedor}</strong> · {grupo.cardCode} · {grupo.filas.length}{" "}
                        {grupo.filas.length === 1 ? "factura" : "facturas"}
                        {grupo.vencido > 0
                          ? ` · Total vencido ${money(String(grupo.vencido), grupo.moneda)}`
                          : " · Sin saldo vencido"}
                      </td>
                    </tr>
                    {grupo.filas.map((f) => (
                  <tr key={f.folio} className="whitespace-nowrap">
                    {/* Una fila, una línea: el código del proveedor va INLINE
                        junto al nombre, no en un segundo renglón. */}
                    <td className="min-w-0 truncate" title={f.proveedor}>
                      {f.proveedor}{" "}
                      <span className="cr-mono text-[10px] text-[color:var(--cr-ink-3)]">
                        {f.cardCode}
                      </span>
                    </td>
                    <td className="cr-mono">{f.folio}</td>
                    <td className="cr-mono">
                      {f.ordenCompra ? `OC ${f.ordenCompra}` : "—"}
                      {f.entrada ? <span className="block text-[10px] text-[color:var(--cr-ink-3)]">Entrada {f.entrada}</span> : null}
                    </td>
                    <td className="cr-num">{money(f.total, f.moneda)}</td>
                    <td><Badge tono={f.credito.vencida ? "danger" : undefined}>{textoCredito(f.credito)}</Badge></td>
                    {filtro !== "pendientes" ? (
                      <td>
                        <Badge tono={f.enEspera ? "warn" : TONO[f.estatus]}>
                          {f.enEspera ? "En espera" : ETIQUETA[f.estatus] ?? f.estatus}
                        </Badge>
                      </td>
                    ) : null}
                    <td
                      className="cr-mono"
                      title={f.motivoArchivo ? `Motivo: ${f.motivoArchivo}` : undefined}
                    >
                      {fecha(f.archivada ?? f.enviada)}
                    </td>
                    <td>
                      <div className="flex justify-end gap-1.5">
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
                              className="cr-btn cr-btn--secondary cr-btn--sm"
                              disabled={archivando === f.folio}
                              onClick={() => void archivar(f, false)}
                            >
                              {archivando === f.folio ? "…" : "Restaurar"}
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="cr-btn cr-btn--secondary cr-btn--sm"
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
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </Tabla>
          )}
        </div>

        {!cargando && visibles.length > 0 ? (
          <Paginacion
            pagina={paginaActual}
            paginas={paginas}
            total={visibles.length}
            porPagina={tamano}
            onCambiar={setPagina}
            sustantivo="peticiones"
          />
        ) : null}
      </Panel>

      {/* Confirmación de archivado. Dice qué NO pasa —no se borra, se puede
          deshacer— porque el miedo a perder un CFDI es lo que hace que nadie
          use el botón y la bandeja acabe llena de ruido. */}
      {porArchivar ? (
        <Modal
          como="form"
          titulo={`Archivar ${porArchivar.folio}`}
          // De quién es y en qué estado, en la cabecera: el cuerpo se queda solo
          // con la consecuencia y con lo que hay que capturar.
          subtitulo={`${porArchivar.proveedor} · ${money(porArchivar.total, porArchivar.moneda)} · ${
            ETIQUETA[porArchivar.estatus] ?? porArchivar.estatus
          }`}
          onCerrar={() => setPorArchivar(null)}
          onSubmit={(e) => {
            e.preventDefault();
            void archivar(porArchivar, true, motivoArchivo);
          }}
          pie={
            <>
              <button
                type="button"
                className="cr-btn cr-btn--ghost cr-btn--sm"
                onClick={() => setPorArchivar(null)}
              >
                Cancelar
              </button>
              <button
                type="submit"
                className="cr-btn cr-btn--primary cr-btn--sm"
                disabled={archivando === porArchivar.folio}
              >
                {archivando === porArchivar.folio ? "Archivando…" : "Archivar"}
              </button>
            </>
          }
        >
          <p className="cr-body">
            Sale de la bandeja, <strong>no se borra</strong>: la factura, sus archivos y su
            bitácora siguen intactos y su estatus no cambia. La restauras cuando quieras desde la
            pestaña Archivadas.
          </p>
          {["EN_REVISION", "NC_EN_REVISION"].includes(porArchivar.estatus) ? (
            <Aviso tono="warn" titulo="Esta petición todavía espera decisión">
              Al archivarla deja de contar como pendiente y el proveedor se queda sin respuesta.
              Si lo que quieres es cerrarla, revísala y recházala con un motivo.
            </Aviso>
          ) : null}
          <Campo label="Motivo (opcional)">
            <input
              className="cr-input cr-input--sm"
              value={motivoArchivo}
              onChange={(e) => setMotivoArchivo(e.target.value)}
              placeholder="Duplicada por error del proveedor"
              maxLength={500}
            />
          </Campo>
        </Modal>
      ) : null}

      {abierta ? (
        <>
          <div className="cr-backdrop" onClick={() => setAbierta(null)} />
          <aside
            className="cr-revision"
            role="dialog"
            aria-modal="true"
            aria-label="Revisar petición"
          >
            <div className="cr-revision__head">
              <div className="min-w-0">
                <h3 className="cr-h3 truncate" title={abierta.peticion.proveedor}>
                  {abierta.peticion.proveedor}
                </h3>
                <div className="cr-small cr-mono">
                  {money(abierta.peticion.total, abierta.peticion.moneda)}
                  {abierta.peticion.ordenCompra ? ` · OC ${abierta.peticion.ordenCompra}` : ""}
                  {abierta.peticion.entrada ? ` · Entrada ${abierta.peticion.entrada}` : ""}
                  {` · ${abierta.peticion.folio}`}
                </div>
              </div>
              {/* Icono y no la palabra "Cerrar": es la acción de descarte de un
                  panel, no una decisión, y compite con los botones del pie. */}
              <button
                type="button"
                className="cr-toast__cerrar"
                onClick={() => setAbierta(null)}
                aria-label="Cerrar el panel de revisión"
              >
                <X strokeWidth={1.75} />
              </button>
            </div>

            <div className="cr-revision__cuerpo">
            {/* Fuera el resumen de lo normal: cuando todo cuadra, la tabla de
                abajo ya lo dice y la frase solo repetia. Se conservan los dos
                casos que SI cambian la decision y que la tabla no puede mostrar:
                facturar de mas, y no haber podido comprobarlo. */}
            {abierta.cobertura?.estado === "EXCEDE" ? (
              <Aviso tono="danger" titulo="Se factura por encima de la orden">
                El CFDI cubre más de lo que pide la OC {abierta.peticion.ordenCompra}.
              </Aviso>
            ) : !abierta.cobertura && abierta.peticion.ordenCompra ? (
              <Aviso tono="warn" titulo="No se pudo comprobar la cobertura">
                No se pudo leer la OC {abierta.peticion.ordenCompra} en Business One: no se sabe
                cuánto falta. No es lo mismo que estar cubierta.
              </Aviso>
            ) : null}

            {abierta.peticion.comentarioProveedor ? (
              <Aviso tono="warn" titulo="Comentario del proveedor">
                {abierta.peticion.comentarioProveedor}
              </Aviso>
            ) : null}

            {abierta.cotejo ? (
              <Panel title={`Entrada ${abierta.peticion.entrada ?? "—"} contra factura`} sinPadding>
                <p className="cr-body px-[18px] py-3">{abierta.cotejo.summary}</p>
                <div className="cr-table-scroll">
                  <table className="cr-table cr-table--compact">
                    <thead>
                      <tr><th>Concepto</th><th className="cr-num">Recibido</th><th className="cr-num">Facturado</th><th className="cr-num">Importe recibido</th><th className="cr-num">Importe CFDI</th></tr>
                    </thead>
                    <tbody>
                      {(abierta.cotejo.lineas ?? []).map((linea, indice) => (
                        <tr key={indice}>
                          <td>{linea.descripcion}</td>
                          <td className="cr-num">{linea.cantidadRecibida ?? "—"}</td>
                          <td className="cr-num">{linea.cantidadFacturada ?? "—"}</td>
                          <td className="cr-num">{linea.importeRecibido === null ? "—" : cifra(linea.importeRecibido)}</td>
                          <td className="cr-num">{linea.importeFacturado === null ? "—" : cifra(linea.importeFacturado)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr><td>Total con impuestos · {abierta.peticion.moneda}</td><td /><td /><td className="cr-num">{cifra(abierta.cotejo.receiptTotal)}</td><td className="cr-num">{cifra(abierta.cotejo.invoiceTotal)}</td></tr>
                    </tfoot>
                  </table>
                </div>
              </Panel>
            ) : null}

            {bloqueantes.length > 0 ? (
              <Aviso tono="danger" titulo="No pasó las validaciones del portal">
                <ul className="list-disc pl-4">
                  {bloqueantes.map((v) => (
                    <li key={v.regla}>{v.detalle}</li>
                  ))}
                </ul>
              </Aviso>
            ) : null}

            {abierta.cobertura ? (
              /* Cada sub-sección del panel va en SU panel, con su cabecera.
                 Antes eran títulos sueltos sobre un flujo plano: la tabla, la
                 lista de documentos y el bloque plegado se sucedían sin nada
                 que dijera dónde acaba una cosa y empieza la otra. */
              <Panel title="Orden de compra contra factura" sinPadding>
                <div className="cr-table-scroll">
                  {/* Densidad compacta en el cuerpo: son pocas líneas y cortas.
                      El pie conserva su aire —tiene regla propia— así que el
                      contraste entre datos densos y total holgado se mantiene. */}
                  <table className="cr-table cr-comparativa cr-table--fija cr-table--compact">
                    {/* Anchos declarados: el concepto es la columna elástica y
                        la que recorta; las tres de cifras no pueden encogerse o
                        los números de una fila se tocan con los de la vecina. */}
                    <colgroup>
                      <col />
                      <col style={{ width: 104 }} />
                      <col style={{ width: 104 }} />
                      <col style={{ width: 116 }} />
                    </colgroup>
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
                        const falta = Number(l.restante);
                        const sobra = Number(l.excedente);
                        return (
                          <tr key={l.lineNum}>
                            <td className="min-w-0 truncate" title={l.description}>
                              {l.itemCode ?? "—"}{" "}
                              <span className="text-[10px] text-[color:var(--cr-ink-3)]">
                                {l.description}
                              </span>
                            </td>
                            <td className="cr-num">{l.ordenado}</td>
                            <td className="cr-num">
                              {l.enEsta}
                              {Number(l.facturadoAntes) > 0 ? (
                                <span className="text-[10px] text-[color:var(--cr-ink-3)]">
                                  {" "}
                                  +{l.facturadoAntes} antes
                                </span>
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
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot>
                      <tr>
                        {/* La moneda se dice una vez aquí, no en cada celda. */}
                        <td>Importe con IVA · {abierta.peticion.moneda}</td>
                        <td className="cr-num">{cifra(abierta.cobertura.totalOrden)}</td>
                        <td className="cr-num">{cifra(abierta.peticion.total)}</td>
                        <td className="cr-num">
                          {cifra(Number(abierta.peticion.total) - abierta.cobertura.totalOrden)}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </Panel>
            ) : null}

            {abierta.cobertura && abierta.cobertura.sinCorrespondencia.length > 0 ? (
              <Aviso tono="danger" titulo="El CFDI trae conceptos que la orden no pidió">
                {abierta.cobertura.sinCorrespondencia
                  .map((c) => `${c.itemCode ?? c.description} (${c.quantity})`)
                  .join(", ")}
              </Aviso>
            ) : null}

            {/* Los documentos van visibles y con nombre propio: quien revisa
                tiene que poder abrir el XML y la evidencia sin buscarlos. */}
            <Panel title="Documentos" sinPadding>
              <div className="cr-docs">
                <Documento
                  tipo="XML"
                  fileKey={abierta.peticion.xmlFileKey}
                  nombre="CFDI timbrado"
                  nota="el comprobante fiscal"
                />
                <Documento
                  tipo="PDF"
                  fileKey={abierta.peticion.pdfFileKey}
                  nombre="Representación impresa"
                />
                {/* La evidencia lleva titulo y descripcion, no solo el archivo:
                    sin ellos KPS no sabe que esta mirando. */}
                {abierta.peticion.evidencias.length === 0 ? (
                  <Documento tipo="EVID" fileKey={null} nombre="Evidencia" />
                ) : (
                  abierta.peticion.evidencias.map((e) => (
                    <Documento
                      key={e.fileKey}
                      tipo="EVID"
                      fileKey={e.fileKey}
                      nombre={e.title || "Evidencia"}
                      nota={e.description}
                    />
                  ))
                )}
              </div>
            </Panel>

            {abierta.peticion.tipo === "MERCANCIA" && abierta.peticion.evidencias.length ? (
              <button
                type="button"
                className="cr-btn cr-btn--secondary cr-btn--sm"
                disabled={analizandoSello}
                onClick={() => void analizarSello()}
              >
                <Sparkles strokeWidth={1.75} />
                {analizandoSello ? "Analizando sello…" : selloAprobado ? "Volver a analizar sello" : "Analizar sello con IA"}
              </button>
            ) : null}

            {/* Plegado y SIN panel a propósito: hace falta para auditar, no para
                decidir. Como disclosure ligero se lee como nota al pie y no
                compite con los dos bloques de arriba, que sí son la revisión. */}
            <details className="cr-detalle-fiscal">
              <summary className="cr-small">Datos fiscales del CFDI</summary>
              <table className="cr-table cr-table--compact">
                <tbody>
                  <tr>
                    <td>Folio del portal</td>
                    <td className="cr-mono">{abierta.peticion.folio}</td>
                  </tr>
                  <tr>
                    <td>Serie y folio del CFDI</td>
                    <td className="cr-mono">{[abierta.peticion.serie, abierta.peticion.folioFiscal].filter(Boolean).join(" · ") || "—"}</td>
                  </tr>
                  <tr><td>Emitida</td><td className="cr-mono">{fecha(abierta.peticion.fechaEmision)}</td></tr>
                  <tr><td>Método y forma de pago</td><td className="cr-mono">{abierta.peticion.metodoPago ?? "—"} · {abierta.peticion.formaPago ?? "—"}</td></tr>
                  <tr><td>Retenciones</td><td className="cr-mono">{money(abierta.peticion.retenidos, abierta.peticion.moneda)}</td></tr>
                  <tr>
                    <td>UUID</td>
                    <td className="cr-mono">{abierta.peticion.uuid || "—"}</td>
                  </tr>
                  <tr>
                    <td>RFC emisor</td>
                    <td className="cr-mono">{abierta.peticion.rfcEmisor || "—"}</td>
                  </tr>
                  <tr>
                    <td>RFC receptor</td>
                    <td className="cr-mono">{abierta.peticion.rfcReceptor || "—"}</td>
                  </tr>
                  <tr>
                    <td>Subtotal e IVA</td>
                    <td className="cr-mono">
                      {money(abierta.peticion.subtotal, abierta.peticion.moneda)} +{" "}
                      {money(abierta.peticion.trasladados, abierta.peticion.moneda)}
                    </td>
                  </tr>
                  <tr>
                    <td>Entrada de mercancía</td>
                    <td className="cr-mono">{abierta.peticion.entrada || "—"}</td>
                  </tr>
                </tbody>
              </table>
            </details>

            <details className="cr-detalle-fiscal">
              <summary className="cr-small">Historial de la factura</summary>
              <ul className="cr-small">
                {abierta.bitacora.map((evento, indice) => (
                  <li key={indice}>{fecha(evento.cuando)} · {ETIQUETA[evento.a] ?? evento.a}{evento.comentario ? `: ${evento.comentario}` : ""}</li>
                ))}
              </ul>
            </details>

            {abierta.peticion.sapError ? <Aviso tono="danger" titulo="Registro SAP pendiente">{abierta.peticion.sapError}</Aviso> : null}
            {abierta.peticion.sapDocNum ? <p className="cr-body">Factura en SAP: <strong>{abierta.peticion.sapDocNum}</strong></p> : null}

            {abierta.peticion.credito.inicio ? (
              <Aviso tono={abierta.peticion.credito.vencida ? "danger" : "ok"} titulo="Plazo de crédito">
                Inició al liberarse el {fecha(abierta.peticion.credito.inicio)} · {textoCredito(abierta.peticion.credito)}
                {abierta.peticion.credito.vencimiento ? ` · vencimiento ${fecha(abierta.peticion.credito.vencimiento)}` : " · días no configurados"}
              </Aviso>
            ) : null}

            {abierta.peticion.tipo === "MERCANCIA" ? (
              <Panel title="Validación visual de la póliza" sinPadding>
                <p className="cr-body px-[18px] py-3">Vista previa antes del registro automático en SAP.</p>
                <table className="cr-table cr-table--compact">
                  <thead><tr><th>Movimiento</th><th>Cuenta</th><th>Descripción</th><th className="cr-num">Importe</th></tr></thead>
                  <tbody>
                    {abierta.polizaPrevia.movimientos.map((movimiento) => (
                      <tr key={`${movimiento.tipo}-${movimiento.cuenta}`}>
                        <td>{movimiento.tipo === "CARGO" ? "Cargo" : "Abono"}</td>
                        <td className="cr-mono">{movimiento.cuenta}</td>
                        <td>{movimiento.descripcion}</td>
                        <td className="cr-num">{money(abierta.polizaPrevia.importe, abierta.polizaPrevia.moneda)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Panel>
            ) : null}

            {abierta.peticion.estatus === "PAGADA" ? (
              <Panel title="Comprobante y complemento de pago">
                {abierta.peticion.pago.comprobanteFileKey ? (
                  <Documento tipo="PAGO" fileKey={abierta.peticion.pago.comprobanteFileKey} nombre="Comprobante de transferencia" />
                ) : (
                  <form onSubmit={subirComprobante} className="grid gap-3">
                    <label className="cr-label" htmlFor="comprobante-transferencia">Comprobante de tesorería</label>
                    <input id="comprobante-transferencia" className="cr-input" name="archivo" type="file" accept="application/pdf,image/jpeg,image/png,image/webp" required />
                    <button className="cr-btn cr-btn--secondary cr-btn--sm" type="submit" disabled={subiendoComprobante}>
                      {subiendoComprobante ? "Cargando…" : "Cargar y habilitar complemento"}
                    </button>
                  </form>
                )}
                {abierta.peticion.pago.complementoEstatus === "PENDIENTE" ? (
                  <Aviso tono="danger" titulo="Complemento pendiente">Vence {fecha(abierta.peticion.pago.complementoLimite)}. Después se bloquean nuevas facturas y dispersiones.</Aviso>
                ) : abierta.peticion.pago.complementoEstatus === "RECIBIDO" ? (
                  <Aviso tono="ok" titulo="Complemento recibido">El proveedor cumplió con el complemento.</Aviso>
                ) : null}
              </Panel>
            ) : null}

            {abierta.peticion.estatus === "APROBADA_PAGO" ? (
              <button className="cr-btn cr-btn--primary cr-btn--sm" disabled={decidiendo} onClick={() => void reintentarSap()}>
                Reintentar registro en SAP
              </button>
            ) : null}

            {/* Pago simulado. Solo para facturas ya registradas en B1 y solo con
                la bandera de pruebas: en produccion no aparece y la ruta
                responde 403. */}
            {PAGO_SIMULADO &&
            ["REGISTRADA_SAP", "CUENTAS_POR_PAGAR"].includes(abierta.peticion.estatus) ? (
              <Aviso tono="warn" titulo="Herramienta de pruebas">
                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                  <span>Crea el pago en B1. En la operación real lo hace tesorería.</span>
                  <button
                    type="button"
                    className="cr-btn cr-btn--secondary cr-btn--sm"
                    onClick={() => void pagarSimulado()}
                    disabled={decidiendo}
                  >
                    <Check strokeWidth={1.75} /> Simular pago
                  </button>
                </div>
              </Aviso>
            ) : null}
            </div>

            {/* Pie de decisión: anclado abajo y siempre visible. El motivo va
                aquí y no en el cuerpo porque devolver y rechazar lo exigen, y
                tenerlo lejos de sus botones obliga a subir y bajar. */}
            {[
              "EN_REVISION",
              "NC_EN_REVISION",
            ].includes(abierta.peticion.estatus) ? (
            <div className="cr-revision__pie">
              <input
                className="cr-input cr-input--sm"
                value={motivo}
                onChange={(e) => setMotivo(e.target.value)}
                placeholder="Motivo — obligatorio para devolver o rechazar"
                aria-label="Motivo de la decisión"
              />
              <div className="cr-decision__botones">
                <button
                  type="button"
                  className="cr-btn cr-btn--primary cr-btn--sm"
                  onClick={() => void decidir("aprobar")}
                  disabled={decidiendo || bloqueantes.length > 0 || (
                    abierta.peticion.tipo === "MERCANCIA" && (
                      !selloAprobado ||
                      !abierta.cotejo?.canProceed ||
                      !abierta.peticion.xmlFileKey ||
                      !abierta.peticion.pdfFileKey ||
                      !abierta.peticion.evidencias.length
                    )
                  )}
                >
                  <Check strokeWidth={1.75} /> Aprobar para pago
                </button>
                {!abierta.peticion.enEspera ? (
                  <button
                    type="button"
                    className="cr-btn cr-btn--secondary cr-btn--sm"
                    onClick={() => void decidir("esperar")}
                    disabled={decidiendo}
                  >
                    <Pause strokeWidth={1.75} /> Dejar en espera
                  </button>
                ) : null}
                <button
                  type="button"
                  className="cr-btn cr-btn--secondary cr-btn--sm"
                  onClick={() => void decidir("corregir")}
                  disabled={decidiendo || !motivo.trim()}
                  title={motivo.trim() ? undefined : "Escribe el motivo para devolverla"}
                >
                  <RotateCcw strokeWidth={1.75} /> Devolver
                </button>
                <button
                  type="button"
                  className="cr-btn cr-btn--danger cr-btn--sm"
                  onClick={() => void decidir("rechazar")}
                  disabled={decidiendo || !motivo.trim()}
                  title={motivo.trim() ? undefined : "Escribe el motivo del rechazo"}
                >
                  <X strokeWidth={1.75} /> Rechazar
                </button>
              </div>
            </div>
            ) : null}
          </aside>
        </>
      ) : null}
    </>
  );
}
