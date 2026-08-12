"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { ArrowUp, Loader2, MessageSquarePlus, PanelLeft, Square, Trash2 } from "lucide-react";
import { api, ClientApiError } from "@/components/lib/api-client";
import { Badge } from "@/components/ui/basicos";
import { BrandMark } from "@/components/ui/BrandMark";

interface ChatItem {
  id: string;
  titulo: string;
  updatedAt: string;
}

interface MensajeGuardado {
  id: string;
  rol: "user" | "assistant";
  contenido: string;
}

function aUIMessages(mensajes: MensajeGuardado[]): UIMessage[] {
  return mensajes.map((m) => ({
    id: m.id,
    role: m.rol,
    parts: [{ type: "text", text: m.contenido }],
  }));
}

function textoDe(m: UIMessage): string {
  return m.parts
    .map((p) => (p.type === "text" ? p.text : ""))
    .join("")
    .trim();
}

function Conversacion({
  chatId,
  onActualizado,
}: {
  chatId: string;
  onActualizado: () => void;
}) {
  const [entrada, setEntrada] = useState("");
  const [cargandoHistorial, setCargandoHistorial] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: "/api/ai/chat",
        prepareSendMessagesRequest: ({ messages }) => ({
          body: { chatId, messages },
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

  function enviar(e: React.FormEvent) {
    e.preventDefault();
    const texto = entrada.trim();
    if (!texto || ocupado) return;
    setEntrada("");
    void sendMessage({ text: texto });
  }

  return (
    <>
      <div ref={scrollRef} className="cr-chat__scroll">
        <div className="mx-auto flex max-w-2xl flex-col gap-4 px-4 py-6">
          {cargandoHistorial ? (
            <p className="cr-small text-center">Cargando conversación…</p>
          ) : messages.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-20 text-center">
              <BrandMark variant="mark" tone="ink" height={32} />
              <p className="cr-body">¿En qué te ayudo hoy?</p>
            </div>
          ) : (
            messages.map((m) =>
              m.role === "user" ? (
                <div key={m.id} className="cr-msg-user">
                  {textoDe(m)}
                </div>
              ) : (
                <div key={m.id} className="cr-msg-assistant">
                  <span
                    className="cr-label block pb-1.5"
                    style={{ color: "var(--cr-accent)" }}
                  >
                    Cronos IA
                  </span>
                  {textoDe(m)}
                </div>
              )
            )
          )}
          {status === "submitted" ? (
            <div className="cr-msg-assistant">
              <span className="cr-label block pb-1.5" style={{ color: "var(--cr-accent)" }}>
                Cronos IA
              </span>
              <Loader2 className="cr-spin" size={14} strokeWidth={1.75} />
            </div>
          ) : null}
          {error ? (
            <p className="cr-small" style={{ color: "var(--cr-danger)" }} role="alert">
              No se pudo obtener respuesta. Intenta de nuevo.
            </p>
          ) : null}
        </div>
      </div>
      <form
        onSubmit={enviar}
        className="border-t p-3"
        style={{ borderColor: "var(--cr-line)" }}
      >
        <div
          className="mx-auto flex max-w-2xl items-center gap-2 border bg-white p-1.5 pl-3"
          style={{ borderColor: "var(--cr-line-2)", borderRadius: "var(--cr-r-xs)" }}
        >
          <input
            className="w-full bg-transparent text-[13.5px] outline-none"
            placeholder="Escribe un mensaje…"
            value={entrada}
            onChange={(e) => setEntrada(e.target.value)}
            maxLength={8000}
          />
          {ocupado ? (
            <button type="button" className="cr-chat-send" onClick={stop} aria-label="Detener">
              <Square strokeWidth={1.75} />
            </button>
          ) : (
            <button
              type="submit"
              className={`cr-chat-send${entrada.trim() ? " cr-chat-send--active" : ""}`}
              aria-label="Enviar"
              disabled={!entrada.trim()}
            >
              <ArrowUp strokeWidth={1.75} />
            </button>
          )}
        </div>
      </form>
    </>
  );
}

export function ChatShell() {
  const [chats, setChats] = useState<ChatItem[]>([]);
  const [chatId, setChatId] = useState<string | null>(null);
  const [sidebarAbierto, setSidebarAbierto] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    // fetch-on-mount: el flag de carga se activa al iniciar la petición
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void cargarChats();
  }, [cargarChats]);

  async function nuevoChat() {
    try {
      const r = await api<{ id: string }>("/api/ai/chats", {
        method: "POST",
        body: JSON.stringify({}),
      });
      await cargarChats();
      setChatId(r.id);
      setSidebarAbierto(false);
    } catch (e) {
      setError(e instanceof ClientApiError ? e.message : "No se pudo crear el chat");
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

  const listaChats = (
    <div className="cr-chat__sidebar">
      <div className="flex items-center gap-2 border-b p-3" style={{ borderColor: "var(--cr-line-soft)" }}>
        <button type="button" className="cr-btn cr-btn--ai cr-btn--sm w-full justify-center" onClick={nuevoChat}>
          <MessageSquarePlus strokeWidth={1.75} />
          Nueva conversación
        </button>
      </div>
      <div className="flex-1 overflow-y-auto py-2">
        {chats.map((c) => (
          <div
            key={c.id}
            className={`cr-navlink cursor-pointer justify-between${c.id === chatId ? " cr-navlink--active" : ""}`}
            onClick={() => {
              setChatId(c.id);
              setSidebarAbierto(false);
            }}
          >
            <span className="truncate">{c.titulo}</span>
            <button
              type="button"
              aria-label="Borrar conversación"
              className="shrink-0 opacity-50 hover:opacity-100"
              onClick={(e) => {
                e.stopPropagation();
                void borrarChat(c.id);
              }}
            >
              <Trash2 size={13} strokeWidth={1.75} />
            </button>
          </div>
        ))}
        {chats.length === 0 ? (
          <p className="cr-small px-4 py-3">Sin conversaciones todavía.</p>
        ) : null}
      </div>
    </div>
  );

  return (
    <div className="cr-chat">
      <div className="hidden lg:flex">{listaChats}</div>
      {sidebarAbierto ? (
        <>
          <div className="cr-backdrop lg:hidden" onClick={() => setSidebarAbierto(false)} />
          <div className="fixed inset-y-0 left-0 z-40 lg:hidden">{listaChats}</div>
        </>
      ) : null}

      <div className="cr-chat__main">
        <div
          className="flex items-center gap-2 border-b px-4 py-3"
          style={{ borderColor: "var(--cr-line)" }}
        >
          <button
            type="button"
            className="cr-btn cr-btn--ghost cr-btn--sm lg:hidden"
            onClick={() => setSidebarAbierto(true)}
            aria-label="Abrir conversaciones"
          >
            <PanelLeft strokeWidth={1.75} />
          </button>
          <span className="cr-h3" style={{ color: "var(--cr-accent)" }}>
            Cronos IA
          </span>
          <Badge tono="ai">IA</Badge>
          <span className="cr-small ml-auto hidden sm:block">
            Módulo independiente: no consulta los datos de Retail
          </span>
        </div>

        {error ? (
          <p className="cr-small px-4 py-2" style={{ color: "var(--cr-danger)" }} role="alert">
            {error}
          </p>
        ) : null}

        {chatId ? (
          <Conversacion key={chatId} chatId={chatId} onActualizado={cargarChats} />
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
            <BrandMark variant="mark" tone="ink" height={36} />
            <p className="cr-h3">Cronos IA</p>
            <p className="cr-body max-w-xs">
              Crea una conversación para empezar a chatear con el asistente.
            </p>
            <button type="button" className="cr-btn cr-btn--ai" onClick={nuevoChat}>
              <MessageSquarePlus strokeWidth={1.75} />
              Nueva conversación
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
