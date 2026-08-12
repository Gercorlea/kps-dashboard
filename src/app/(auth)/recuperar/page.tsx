"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { api, ClientApiError } from "@/components/lib/api-client";

export default function RecuperarPage() {
  const [email, setEmail] = useState("");
  const [mensaje, setMensaje] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(false);

  async function enviar(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setCargando(true);
    try {
      const r = await api<{ mensaje: string }>("/api/auth/recuperar", {
        method: "POST",
        body: JSON.stringify({ email }),
      });
      setMensaje(r.mensaje);
    } catch (err) {
      setError(err instanceof ClientApiError ? err.message : "No se pudo enviar el correo");
    } finally {
      setCargando(false);
    }
  }

  if (mensaje) {
    return (
      <div className="flex flex-col gap-4 text-center">
        <h1 className="cr-h2">Revisa tu correo</h1>
        <p className="cr-body">{mensaje}</p>
        <a href="/login" className="cr-small cr-link">
          Volver al inicio de sesión
        </a>
      </div>
    );
  }

  return (
    <form onSubmit={enviar} className="flex flex-col gap-4">
      <h1 className="cr-h2 text-center">Recuperar contraseña</h1>
      <p className="cr-body text-center">
        Te enviaremos un enlace de un solo uso para crear una nueva contraseña.
      </p>
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
        <p className="cr-small" style={{ color: "var(--cr-danger)" }} role="alert">
          {error}
        </p>
      ) : null}
      <button type="submit" className="cr-btn cr-btn--primary justify-center" disabled={cargando}>
        {cargando ? <Loader2 className="cr-spin" strokeWidth={1.75} /> : null}
        Enviar enlace
      </button>
      <a href="/login" className="cr-small cr-link text-center">
        Volver al inicio de sesión
      </a>
    </form>
  );
}
