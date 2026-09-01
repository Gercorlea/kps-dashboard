"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { Markdown } from "@/components/chat/Markdown";
import { ReporteCard } from "@/components/chat/ReporteCard";
import { formatoUSD } from "@/lib/ai-modelos";
import type { ResultadoReporte } from "@/lib/reportes/crear-reporte";
import {
  ArrowUp,
  ChevronDown,
  FileText,
  Lightbulb,
  Mail,
  MessageSquare,
  PanelLeft,
  Percent,
  Plus,
  Search,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { api, ClientApiError, fetchConSesion } from "@/components/lib/api-client";
import { MODELO_DEFECTO, MODELOS_IA } from "@/lib/ai-modelos";

// Chat de KPS AI con el diseño CRONOS portado de Industria Real:
// sidebar colapsable con búsqueda, historial agrupado por fecha, saludo
// con sugerencias, remitente del assistant con tint morado y cursor de
// streaming. El morado queda SOLO en este módulo (§4.7).

interface ChatItem {
  id: string;
  title: string;
  updatedAt: string;
}

interface MensajeGuardado {
  id: string;
  role: "user" | "assistant";
  content: string;
  tools?: Array<{ name: string; args?: unknown; result?: unknown }>;
}

const SUGERENCIAS = [
  { icono: Mail, texto: "Redacta un correo profesional para un cliente" },
  { icono: FileText, texto: "Resume estos puntos en un párrafo ejecutivo" },
  { icono: Percent, texto: "Explícame qué es el fill rate y cómo se calcula" },
  { icono: Lightbulb, texto: "Dame ideas para presentar un scorecard a un cliente" },
];

// El transport lanza el cuerpo de la respuesta tal cual cuando el servidor
// no responde 200. Mostrar solo "intenta de nuevo" escondía la causa real
// (sesión vencida, límite de peticiones, historial rechazado) y dejaba el
// fallo sin diagnóstico posible.
function motivoDelError(error: Error): string {
  try {
    const cuerpo = JSON.parse(error.message) as { error?: { message?: string } };
    if (cuerpo.error?.message) return cuerpo.error.message;
  } catch {
    // No era el contrato { ok, error }: caemos al mensaje genérico.
  }
  return "No se pudo obtener respuesta. Intenta de nuevo.";
}

// Reconstruye el mensaje guardado. Las llamadas a herramientas se vuelven
// partes del mensaje para que la tarjeta de reporte siga ahí al recargar la
// conversación; sin esto el reporte se perdería y habría que regenerarlo.
function aUIMessages(mensajes: MensajeGuardado[]): UIMessage[] {
  return mensajes.map((m) => {
    const partes: UIMessage["parts"] = [{ type: "text", text: m.content }];
    for (const h of m.tools ?? []) {
      if (h.name !== "crear_reporte" || !h.result) continue;
      partes.push({
        type: "tool-crear_reporte",
        toolCallId: `${m.id}-${partes.length}`,
        state: "output-available",
        input: h.args,
        output: h.result,
      } as UIMessage["parts"][number]);
    }
    return { id: m.id, role: m.role, parts: partes };
  });
}

function textoDe(m: UIMessage): string {
  return m.parts
    .map((p) => (p.type === "text" ? p.text : ""))
    .join("")
    .trim();
}

// La línea "▸ Consultó …" es lo único del motor que ve el usuario, y él es de
// negocio: mostrar "BusinessPartners" o "dcStock" no le dice nada. Se traduce
// a la palabra del negocio y, si el nombre no está en el mapa, se omite en
// vez de filtrar el técnico.
const NOMBRES_FUENTE: Record<string, string> = {
  businesspartners: "socios de negocio",
  items: "artículos",
  orders: "pedidos",
  invoices: "facturas",
  quotations: "cotizaciones",
  purchaseorders: "órdenes de compra",
  purchaseinvoices: "facturas de compra",
  deliverynotes: "entregas",
  purchasedeliverynotes: "entradas de mercancía",
  creditnotes: "notas de crédito",
  warehouses: "almacenes",
  pricelists: "listas de precios",
  itemgroups: "grupos de artículos",
  sales: "ventas",
  sapsales: "ventas facturadas",
  weeklyforecast: "pronóstico semanal",
  dailyforecast: "pronóstico diario",
  dcstock: "inventario de CEDIS",
  pharmacystock: "inventario de farmacias",
  uploads: "cargas",
};

function etiquetasConsultadas(partes: UIMessage["parts"]): string[] {
  const etiquetas: string[] = [];
  for (const p of partes) {
    if (!p.type.startsWith("tool-") || p.type === "tool-crear_reporte") continue;
    const entrada = (p as { input?: { entidad?: string; coleccion?: string } }).input;
    const bruto = entrada?.entidad ?? entrada?.coleccion;
    if (!bruto) continue;
    // "Items('INS0002')" → "items"; los nombres desconocidos no se muestran.
    const etiqueta = NOMBRES_FUENTE[bruto.split("(")[0].toLowerCase()];
    if (etiqueta && !etiquetas.includes(etiqueta)) etiquetas.push(etiqueta);
  }
  return etiquetas;
}

// true mientras el modelo está tecleando el markdown de crear_reporte (el
// tramo más largo de la respuesta: no llega texto y parece colgado).
function generandoReporte(partes: UIMessage["parts"]): boolean {
  return partes.some(
    (p) =>
      p.type === "tool-crear_reporte" &&
      (p as { state?: string }).state !== "output-available" &&
      (p as { state?: string }).state !== "output-error"
  );
}

function LineaConsultas({ partes }: { partes: UIMessage["parts"] }) {
  const fuentes = etiquetasConsultadas(partes);
  if (!fuentes.length) return null;
  return <p className="cr-label pb-1.5">▸ Consultó {fuentes.join(" · ")}</p>;
}

function grupoDeFecha(iso: string): string {
  const date = new Date(iso);
  const hoy = new Date();
  const inicioHoy = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate());
  const dias = Math.floor((inicioHoy.getTime() - date.getTime()) / 86400000) + 1;
  if (date >= inicioHoy) return "Hoy";
  if (dias <= 1) return "Ayer";
  if (dias <= 7) return "Últimos 7 días";
  return "Anteriores";
}

function ModelPicker({
  model,
  onCambiar,
  deshabilitado,
}: {
  model: string;
  onCambiar: (id: string) => void;
  deshabilitado: boolean;
}) {
  const [abierto, setAbierto] = useState(false);
  const actual = MODELOS_IA.find((m) => m.id === model) ?? MODELOS_IA[0];

  return (
    <div className="cr-chat-model-picker">
      {abierto ? (
        <button
          type="button"
          className="cr-chat-model-picker__backdrop"
          aria-label="Cerrar selector"
          onClick={() => setAbierto(false)}
        />
      ) : null}
      <button
        type="button"
        className="cr-chat-model-picker__btn"
        disabled={deshabilitado}
        onClick={() => setAbierto((v) => !v)}
      >
        {actual.name}
        <ChevronDown
          className={`cr-chat-model-picker__chevron${abierto ? " cr-chat-model-picker__chevron--open" : ""}`}
          strokeWidth={2}
        />
      </button>
      {abierto ? (
        <div className="cr-chat-model-picker__menu" role="listbox">
          {MODELOS_IA.map((m) => (
            <button
              key={m.id}
              type="button"
              role="option"
              aria-selected={m.id === model}
              className={`cr-chat-model-picker__option${m.id === model ? " cr-chat-model-picker__option--active" : ""}`}
              onClick={() => {
                onCambiar(m.id);
                setAbierto(false);
              }}
            >
              <span className="cr-chat-model-picker__option-name">{m.name}</span>
              <span className="cr-chat-model-picker__option-price">{m.precio}</span>
            </button>
          ))}
          <p className="cr-chat-model-picker__menu-hint">
            Precio por millón de tokens (entrada / salida). Aplica al siguiente message.
          </p>
        </div>
      ) : null}
    </div>
  );
}

interface MetadataUso {
  model?: string;
  entrada?: number;
  salida?: number;
  costo?: number;
}

// Consumo de la respuesta: el endpoint lo manda como metadata del mensaje,
// así que no hace falta una petición extra para mostrarlo.
function ConsumoLinea({ metadata }: { metadata?: unknown }) {
  const uso = metadata as MetadataUso | undefined;
  if (!uso?.entrada && !uso?.salida) return null;
  const entrada = uso.entrada ?? 0;
  const salida = uso.salida ?? 0;
  const model = MODELOS_IA.find((m) => m.id === uso.model);
  return (
    <p className="cr-consumo">
      {model ? <span className="cr-consumo__modelo">{model.name}</span> : null}
      <span>{(entrada + salida).toLocaleString("es-MX")} tokens</span>
      <span className="cr-consumo__detalle">
        {entrada.toLocaleString("es-MX")} in · {salida.toLocaleString("es-MX")} out
      </span>
      <span className="cr-consumo__costo">{formatoUSD(uso.costo ?? 0)}</span>
    </p>
  );
}

function RemitenteIA() {
  return (
    <div className="cr-msg-sender">
      <span className="cr-msg-sender__name--ai">KPS AI</span>
      <span className="cr-msg-sender__sep">·</span>
      <span className="cr-msg-sender__tag">Asistente</span>
    </div>
  );
}

function Conversacion({
  chatId,
  entradaInicial,
  onActualizado,
}: {
  chatId: string;
  entradaInicial: string;
  onActualizado: () => void;
}) {
  const [entrada, setEntrada] = useState(entradaInicial);
  const [model, setModelo] = useState(MODELO_DEFECTO);
  const [cargandoHistorial, setCargandoHistorial] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // El modelo viaja en el body por-envío (opciones de sendMessage) y el
  // transport lo fusiona — sin refs leídas en render.
  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: "/api/ai/chat",
        // Renueva la sesión y reintenta si el token venció a media charla.
        fetch: fetchConSesion,
        prepareSendMessagesRequest: ({ messages, body }) => ({
          body: { chatId, messages, ...body },
        }),
      }),
    [chatId]
  );

  const { messages, setMessages, sendMessage, status, stop, error } = useChat({
    id: chatId,
    transport,
    onFinish: onActualizado,
  });

  useEffect(() => {
    let activo = true;
    // fetch-on-mount: el flag de carga se activa al iniciar la petición
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCargandoHistorial(true);
    api<{ mensajes: MensajeGuardado[] }>(`/api/ai/chats/${chatId}`)
      .then((r) => {
        if (activo) setMessages(aUIMessages(r.mensajes));
      })
      .catch(() => {})
      .finally(() => {
        if (activo) setCargandoHistorial(false);
      });
    return () => {
      activo = false;
    };
  }, [chatId, setMessages]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  const ocupado = status === "submitted" || status === "streaming";
  const puedeEnviar = entrada.trim().length > 0 && !ocupado;

  function enviar() {
    const texto = entrada.trim();
    if (!texto || ocupado) return;
    setEntrada("");
    void sendMessage({ text: texto }, { body: { model } });
  }

  function alTeclear(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      enviar();
    }
  }

  const ultimoEsAssistantStreaming =
    status === "streaming" && messages[messages.length - 1]?.role === "assistant";

  // Acumulado de la conversación. Solo cuenta lo enviado en esta sesión: el
  // historial recargado de Mongo no trae la metadata de consumo.
  const totalConversacion = useMemo(
    () =>
      messages.reduce(
        (acc, m) => {
          const u = m.metadata as MetadataUso | undefined;
          if (!u) return acc;
          return {
            tokens: acc.tokens + (u.entrada ?? 0) + (u.salida ?? 0),
            costo: acc.costo + (u.costo ?? 0),
          };
        },
        { tokens: 0, costo: 0 }
      ),
    [messages]
  );

  return (
    <>
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-4 py-6">
          {cargandoHistorial ? (
            <div className="cr-chat-loader">
              <div className="cr-chat-loader__spinner" />
              <p className="cr-chat-loader__label">Cargando conversación…</p>
            </div>
          ) : messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-10">
              <div className="cr-chat-greeting mb-6 text-center">
                <h2 className="cr-chat-greeting__title mb-2">KPS AI</h2>
                <p className="cr-body mx-auto max-w-md">
                  Asistente de Arcanum. Módulo independiente: no consulta los
                  datos de Retail.
                </p>
              </div>
              <div className="grid w-full max-w-lg grid-cols-1 gap-3 md:grid-cols-2">
                {SUGERENCIAS.map((s) => (
                  <button
                    key={s.texto}
                    type="button"
                    className="cr-chat-suggestion"
                    onClick={() => {
                      setEntrada(s.texto);
                      textareaRef.current?.focus();
                    }}
                  >
                    <s.icono size={15} strokeWidth={1.75} />
                    {s.texto}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-5">
              {messages.map((m, idx) =>
                m.role === "user" ? (
                  <div key={m.id} className="cr-msg-block cr-msg-block--user">
                    <div className="cr-msg-user-bubble">
                      <p className="cr-msg-user-text">{textoDe(m)}</p>
                    </div>
                  </div>
                ) : (
                  <div key={m.id} className="cr-msg-block cr-msg-block--assistant">
                    <RemitenteIA />
                    <LineaConsultas partes={m.parts} />
                    <div className="cr-assistant-final">
                      <Markdown>{textoDe(m)}</Markdown>
                      {ultimoEsAssistantStreaming && idx === messages.length - 1 ? (
                        <span className="cr-live-cursor" />
                      ) : null}
                    </div>
                    {ultimoEsAssistantStreaming &&
                    idx === messages.length - 1 &&
                    generandoReporte(m.parts) ? (
                      <div className="cr-live-status">
                        <span className="cr-live-status__pulse">
                          <span />
                          <span />
                          <span />
                        </span>
                        <span className="cr-live-status__label">
                          Generando reporte… puede tardar un momento
                        </span>
                      </div>
                    ) : null}
                    {m.parts
                      .filter((p) => p.type === "tool-crear_reporte")
                      .map((p, i) => {
                        const salida = (p as { output?: ResultadoReporte }).output;
                        return salida ? <ReporteCard key={i} reporte={salida} /> : null;
                      })}
                    <ConsumoLinea metadata={m.metadata} />
                  </div>
                )
              )}
              {status === "submitted" ? (
                <div className="cr-msg-block cr-msg-block--assistant">
                  <RemitenteIA />
                  <div className="cr-live-status">
                    <span className="cr-live-status__pulse">
                      <span />
                      <span />
                      <span />
                    </span>
                    <span className="cr-live-status__label">Pensando…</span>
                  </div>
                </div>
              ) : null}
              {error ? (
                <p className="cr-small" style={{ color: "var(--cr-danger)" }} role="alert">
                  {motivoDelError(error)}
                </p>
              ) : null}
            </div>
          )}
        </div>
      </div>

      <div className="cr-chat-input-bar">
        <div className="mx-auto max-w-3xl">
          <div className="cr-chat-input-compose">
            <div className="cr-chat-input-row">
              <textarea
                ref={textareaRef}
                rows={1}
                placeholder="Escribe un mensaje…"
                value={entrada}
                maxLength={8000}
                onChange={(e) => setEntrada(e.target.value)}
                onKeyDown={alTeclear}
              />
              <div className="cr-chat-input-actions">
                <ModelPicker model={model} onCambiar={setModelo} deshabilitado={ocupado} />
                {ocupado ? (
                  <button
                    type="button"
                    className="cr-chat-send-btn cr-chat-send-btn--active"
                    onClick={stop}
                    aria-label="Detener"
                  >
                    <Square size={13} strokeWidth={2} />
                  </button>
                ) : (
                  <button
                    type="button"
                    className={`cr-chat-send-btn ${puedeEnviar ? "cr-chat-send-btn--active" : "cr-chat-send-btn--idle"}`}
                    onClick={enviar}
                    disabled={!puedeEnviar}
                    aria-label="Enviar"
                  >
                    <ArrowUp size={15} strokeWidth={2} />
                  </button>
                )}
              </div>
            </div>
          </div>
          <p className="cr-chat-input-footer mt-2 text-center">
            KPS AI puede cometer errores. Enter envía · Shift+Enter salto de línea.
            {totalConversacion.tokens > 0 ? (
              <>
                {" · "}
                <span className="cr-consumo__total">
                  Esta conversación: {totalConversacion.tokens.toLocaleString("es-MX")} tokens ·{" "}
                  {formatoUSD(totalConversacion.costo)}
                </span>
              </>
            ) : null}
          </p>
        </div>
      </div>
    </>
  );
}

export function ChatShell() {
  const [chats, setChats] = useState<ChatItem[]>([]);
  const [chatId, setChatId] = useState<string | null>(null);
  const [sidebarAbierto, setSidebarAbierto] = useState(true);
  const [busquedaAbierta, setBusquedaAbierta] = useState(false);
  const [busqueda, setBusqueda] = useState("");
  const [entradaInicial, setEntradaInicial] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // En móvil el sidebar arranca cerrado (overlay bajo la mobile nav).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (window.innerWidth < 1024) setSidebarAbierto(false);
  }, []);

  const cargarChats = useCallback(async () => {
    try {
      const r = await api<{ chats: ChatItem[] }>("/api/ai/chats");
      setChats(r.chats);
      setChatId((actual) => actual ?? r.chats[0]?.id ?? null);
    } catch (e) {
      setError(e instanceof ClientApiError ? e.message : "No se pudieron cargar los chats");
    }
  }, []);

  useEffect(() => {
    // fetch-on-mount
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void cargarChats();
  }, [cargarChats]);

  async function nuevoChat(textoInicial = "") {
    try {
      const r = await api<{ id: string }>("/api/ai/chats", {
        method: "POST",
        body: JSON.stringify({}),
      });
      await cargarChats();
      setEntradaInicial(textoInicial);
      setChatId(r.id);
      if (window.innerWidth < 1024) setSidebarAbierto(false);
    } catch (e) {
      setError(e instanceof ClientApiError ? e.message : "No se pudo crear el chat");
    }
  }

  async function borrarTodos() {
    if (chats.length === 0) return;
    const msg = `¿Borrar TODAS las conversaciones (${chats.length})? Esta acción no se puede deshacer.`;
    if (!window.confirm(msg)) return;
    try {
      await api("/api/ai/chats", { method: "DELETE" });
      setChats([]);
      setChatId(null);
    } catch (e) {
      setError(e instanceof ClientApiError ? e.message : "No se pudieron borrar las conversaciones");
    }
  }

  async function borrarChat(id: string) {
    if (!window.confirm("¿Borrar esta conversación?")) return;
    try {
      await api(`/api/ai/chats/${id}`, { method: "DELETE" });
      setChats((c) => c.filter((x) => x.id !== id));
      setChatId((actual) => (actual === id ? null : actual));
    } catch (e) {
      setError(e instanceof ClientApiError ? e.message : "No se pudo borrar");
    }
  }

  const filtrados = busqueda.trim()
    ? chats.filter((c) => c.title.toLowerCase().includes(busqueda.trim().toLowerCase()))
    : chats;

  const grupos = useMemo(() => {
    const mapa = new Map<string, ChatItem[]>();
    for (const c of filtrados) {
      const g = grupoDeFecha(c.updatedAt);
      mapa.set(g, [...(mapa.get(g) ?? []), c]);
    }
    return ["Hoy", "Ayer", "Últimos 7 días", "Anteriores"]
      .filter((g) => mapa.has(g))
      .map((g) => ({ etiqueta: g, items: mapa.get(g)! }));
  }, [filtrados]);

  return (
    <div className="cr-chat-shell">
      {sidebarAbierto ? (
        <button
          type="button"
          className="cr-chat-backdrop lg:hidden"
          aria-label="Cerrar historial"
          onClick={() => setSidebarAbierto(false)}
        />
      ) : null}

      <aside
        className={`cr-chat-sidebar ${sidebarAbierto ? "cr-chat-sidebar--open" : "cr-chat-sidebar--closed"}`}
      >
        <div className="cr-chat-sidebar-toolbar" data-search-open={busquedaAbierta}>
          <button type="button" className="cr-chat-new-btn" onClick={() => nuevoChat()}>
            <Plus size={15} strokeWidth={2} />
            <span className="cr-chat-new-btn__label">Nueva conversación</span>
          </button>
          <button
            type="button"
            className="cr-chat-search-toggle"
            aria-label="Borrar todas las conversaciones"
            title="Borrar todas las conversaciones"
            onClick={() => void borrarTodos()}
          >
            <Trash2 size={15} strokeWidth={1.75} />
          </button>
          <div className="cr-chat-search-slot">
            <button
              type="button"
              className="cr-chat-search-toggle"
              aria-label="Buscar conversaciones"
              onClick={() => setBusquedaAbierta(true)}
            >
              <Search size={15} strokeWidth={1.75} />
            </button>
            <div className="cr-chat-search-field">
              <Search size={14} strokeWidth={1.75} />
              <input
                placeholder="Buscar…"
                value={busqueda}
                onChange={(e) => setBusqueda(e.target.value)}
                autoFocus={busquedaAbierta}
              />
              <button
                type="button"
                aria-label="Cerrar búsqueda"
                onClick={() => {
                  setBusquedaAbierta(false);
                  setBusqueda("");
                }}
              >
                <X size={14} strokeWidth={1.75} />
              </button>
            </div>
          </div>
        </div>

        <div className="cr-chat-sidebar__list">
          {grupos.map((g) => (
            <div key={g.etiqueta}>
              <div className="cr-chat-group-label">{g.etiqueta}</div>
              {g.items.map((c) => (
                <div
                  key={c.id}
                  className={`cr-chat-item${c.id === chatId ? " cr-chat-item--active" : ""}`}
                >
                  <button
                    type="button"
                    className="cr-chat-item__btn"
                    onClick={() => {
                      setEntradaInicial("");
                      setChatId(c.id);
                      if (window.innerWidth < 1024) setSidebarAbierto(false);
                    }}
                  >
                    <MessageSquare className="cr-chat-item__icon" size={15} strokeWidth={1.75} />
                    <span className="cr-chat-item__title">{c.title}</span>
                  </button>
                  <button
                    type="button"
                    className="cr-chat-item__delete"
                    aria-label="Borrar conversación"
                    onClick={() => borrarChat(c.id)}
                  >
                    <Trash2 size={13} strokeWidth={1.75} />
                  </button>
                </div>
              ))}
            </div>
          ))}
          {filtrados.length === 0 ? (
            <p className="cr-small px-3 py-3">
              {busqueda ? "Sin resultados." : "Sin conversaciones todavía."}
            </p>
          ) : null}
        </div>
      </aside>

      <div className="cr-chat-main">
        <div className="cr-chat-header">
          <div className="cr-chat-header__inner">
            <button
              type="button"
              className="cr-chat-header__sidebar-btn"
              aria-label={sidebarAbierto ? "Ocultar historial" : "Mostrar historial"}
              onClick={() => setSidebarAbierto((v) => !v)}
            >
              <PanelLeft size={16} strokeWidth={1.75} />
            </button>
            <div>
              <span className="cr-msg-sender__name--ai" style={{ fontSize: 14 }}>
                KPS AI
              </span>
              <p className="cr-small">Módulo independiente: no consulta los datos de Retail</p>
            </div>
          </div>
        </div>

        {error ? (
          <p className="cr-small px-4 py-2" style={{ color: "var(--cr-danger)" }} role="alert">
            {error}
          </p>
        ) : null}

        {chatId ? (
          <Conversacion
            key={chatId}
            chatId={chatId}
            entradaInicial={entradaInicial}
            onActualizado={cargarChats}
          />
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center px-4">
            <div className="cr-chat-greeting mb-6 text-center">
              <h2 className="cr-chat-greeting__title mb-2">KPS AI</h2>
              <p className="cr-body mx-auto max-w-md">
                Asistente de Arcanum. Crea una conversación para empezar.
              </p>
            </div>
            <div className="grid w-full max-w-lg grid-cols-1 gap-3 md:grid-cols-2">
              {SUGERENCIAS.map((s) => (
                <button
                  key={s.texto}
                  type="button"
                  className="cr-chat-suggestion"
                  onClick={() => nuevoChat(s.texto)}
                >
                  <s.icono size={15} strokeWidth={1.75} />
                  {s.texto}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="cr-btn cr-btn--ai mt-6"
              onClick={() => nuevoChat()}
            >
              <Plus strokeWidth={1.75} />
              Nueva conversación
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
