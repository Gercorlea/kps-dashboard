"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { CircleAlert, Loader2 } from "lucide-react";
import { api, ClientApiError } from "@/components/lib/api-client";

function FormularioLogin() {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(false);

  async function enviar(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setCargando(true);
    try {
      await api("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      const siguiente = params.get("siguiente");
      router.push(siguiente && siguiente.startsWith("/") ? siguiente : "/dashboard");
      router.refresh();
    } catch (err) {
      // Rate limit visible con mensaje claro, no un 429 crudo (§10).
      setError(err instanceof ClientApiError ? err.message : "No se pudo iniciar sesión");
      setCargando(false);
    }
  }

  return (
    <form onSubmit={enviar} className="flex flex-col gap-4">
      <h1 className="cr-h2 text-center">Iniciar sesión</h1>
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
      <label className="cr-field">
        <span className="cr-label">Contraseña</span>
        <input
          className="cr-input"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
      </label>
      {/* .cr-aviso en vez de un <p> rojo suelto: un fallo de acceso tiene que
          leerse antes que nada, y en linea entre dos campos se pierde. */}
      {error ? (
        <div className="cr-aviso cr-aviso--danger" role="alert">
          <span className="cr-aviso__icono">
            <CircleAlert size={16} strokeWidth={1.75} />
          </span>
          <div className="cr-aviso__cuerpo">
            <div className="cr-aviso__titulo">{error}</div>
          </div>
        </div>
      ) : null}
      <button type="submit" className="cr-btn cr-btn--primary cr-btn--block" disabled={cargando}>
        {cargando ? <Loader2 className="cr-spin" strokeWidth={1.75} /> : null}
        Entrar
      </button>
      <a href="/recuperar" className="cr-small cr-link text-center">
        ¿Olvidaste tu contraseña?
      </a>
    </form>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <FormularioLogin />
    </Suspense>
  );
}
