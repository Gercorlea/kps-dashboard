"use client";

import { useState } from "react";
import { CircleAlert, Check, Loader2 } from "lucide-react";
import { api, ClientApiError } from "@/components/lib/api-client";

export default function RecuperarPage() {
  const [email, setEmail] = useState("");
  const [message, setMensaje] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(false);

  async function enviar(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setCargando(true);
    try {
      const r = await api<{ message: string }>("/api/auth/recuperar", {
        method: "POST",
        body: JSON.stringify({ email }),
      });
      setMensaje(r.message);
    } catch (err) {
      setError(err instanceof ClientApiError ? err.message : "No se pudo enviar el correo");
    } finally {
      setCargando(false);
    }
  }

  if (message) {
    return (
      <div className="cr-auth__form">
        <div className="cr-auth__encabezado">
          <span className="cr-auth__estado cr-auth__estado--ok" aria-hidden="true">
            <Check strokeWidth={1.75} />
          </span>
          <h1 className="cr-h2">Revisa tu correo</h1>
          <p className="cr-body">{message}</p>
        </div>
        <a href="/login" className="cr-auth__recuperar cr-small cr-link">
          Volver al inicio de sesión
        </a>
      </div>
    );
  }

  return (
    <form onSubmit={enviar} className="cr-auth__form">
      <div className="cr-auth__encabezado">
        <h1 className="cr-h2">Recuperar contraseña</h1>
        <p className="cr-small cr-ink-3">
          Recibirás un enlace de un solo uso para crear una nueva contraseña.
        </p>
      </div>
      <label className="cr-field">
        <span className="cr-label">Correo</span>
        <input
          className="cr-input"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
      </label>
      {error ? (
        <div className="cr-aviso cr-aviso--danger" role="alert">
          <span className="cr-aviso__icono"><CircleAlert size={16} strokeWidth={1.75} /></span>
          <div className="cr-aviso__cuerpo"><div className="cr-aviso__titulo">{error}</div></div>
        </div>
      ) : null}
      <button type="submit" className="cr-btn cr-btn--primary cr-btn--block" disabled={cargando}>
        {cargando ? <Loader2 className="cr-spin" strokeWidth={1.75} /> : null}
        Enviar enlace
      </button>
      <a href="/login" className="cr-auth__recuperar cr-small cr-link">
        Volver al inicio de sesión
      </a>
    </form>
  );
}
