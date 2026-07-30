"use client";

import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { Loader2 } from "lucide-react";
import { api, ClientApiError } from "@/components/lib/api-client";

export default function RestablecerPage() {
  const { token } = useParams<{ token: string }>();
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirmacion, setConfirmacion] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(false);

  async function enviar(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password !== confirmacion) {
      setError("Las contraseñas no coinciden");
      return;
    }
    setCargando(true);
    try {
      await api("/api/auth/restablecer", {
        method: "POST",
        body: JSON.stringify({ token, password }),
      });
      router.push("/login");
    } catch (err) {
      setError(err instanceof ClientApiError ? err.message : "No se pudo restablecer");
      setCargando(false);
    }
  }

  return (
    <form onSubmit={enviar} className="flex flex-col gap-4">
      <h1 className="cr-h2 text-center">Nueva contraseña</h1>
      <label className="cr-field">
        <span className="cr-label">Contraseña (mínimo 8 caracteres)</span>
        <input
          className="cr-input"
          type="password"
          autoComplete="new-password"
          minLength={8}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
      </label>
      <label className="cr-field">
        <span className="cr-label">Confirmar contraseña</span>
        <input
          className="cr-input"
          type="password"
          autoComplete="new-password"
          minLength={8}
          value={confirmacion}
          onChange={(e) => setConfirmacion(e.target.value)}
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
        Guardar contraseña
      </button>
    </form>
  );
}
