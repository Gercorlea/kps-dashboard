"use client";

import { X } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

/**
 * Avisos momentáneos. Es la forma de acusar recibo de una operación —"registrado",
 * "guardado", "no se pudo"— sin meter el mensaje en el flujo de la página.
 *
 * POR QUE NO UN <Aviso> ENTRE LOS PANELES. Un acuse en el flujo empuja todo lo
 * que tiene debajo, descuadra la medida del paginado (`useFilasQueCaben` mide
 * desde dónde arranca la lista) y se queda en pantalla para siempre aunque ya
 * nadie lo lea. `<Aviso>` sigue siendo lo correcto para un estado PERSISTENTE
 * de la pantalla —"esta carga falló, vuelve a intentarlo"—, no para un acuse.
 *
 * DURACION. TODOS se van solos con la misma cuenta atrás y la misma barra de
 * tiempo, los de error incluidos. Que unos caducaran y otros no obligaba a mirar
 * el aviso para saber si iba a quedarse, y dejaba errores viejos en pantalla
 * mucho después de haberlos leído.
 *
 * Si un fallo necesita leerse con calma —o copiarse— no es un toast: va en un
 * `<Aviso>` dentro de la pantalla, que es lo que se usa para el error de carga.
 *
 *   const toast = useToast();
 *   toast.ok("Proveedor registrado", "P0001 · Industrias Vía Láctea");
 *   toast.error("No se pudo registrar", e.message);
 */

type Tono = "ok" | "warn" | "danger";

interface Toast {
  id: number;
  tono: Tono;
  titulo: string;
  detalle?: string;
  /** Ya empezó a irse: sigue en el DOM lo que dura la animación de salida. */
  saliendo?: boolean;
}

interface Api {
  ok: (titulo: string, detalle?: string) => void;
  warn: (titulo: string, detalle?: string) => void;
  error: (titulo: string, detalle?: string) => void;
}

const Ctx = createContext<Api | null>(null);

/**
 * Milisegundos que dura en pantalla un aviso que NO es de error.
 *
 * La barra de tiempo del toast lee esta misma constante, así que cambiarla aquí
 * las mueve a la vez y no pueden derivar.
 */
const DURACION = 2500;

/* Contador de ids a nivel de módulo y no en un `useRef`: leer `ref.current`
   dentro del `useMemo` que arma la API es leerlo durante el render, y eso lo
   marca la regla `react-hooks/refs` —con razón: un ref no es estado y su valor
   durante el render no está garantizado. */
let siguienteId = 0;

/** Debe coincidir con la animación `cr-toast-sale` de design-system.css. */
const SALIDA = 180;

export function useToast(): Api {
  const api = useContext(Ctx);
  if (!api) throw new Error("useToast necesita <ToastProvider> por encima");
  return api;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  // Dos pasos: primero se marca `saliendo` —eso dispara la animación— y solo
  // cuando termina se saca de la lista. Quitarlo de golpe lo hace desaparecer
  // en seco, sin darle tiempo a irse.
  //
  // `useCallback` con dependencias vacías NO es cosmético aquí: `cerrar` viaja
  // a cada toast, y si cambiara de identidad en cada render, el efecto que
  // programa el temporizador se volvería a ejecutar cada vez que llega un toast
  // nuevo — reiniciando la cuenta atrás de TODOS los que ya estaban. Ese era el
  // motivo de que se fueran todos juntos al final en vez de uno a uno.
  const cerrar = useCallback((id: number) => {
    setToasts((t) => t.map((x) => (x.id === id ? { ...x, saliendo: true } : x)));
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), SALIDA);
  }, []);

  const api = useMemo<Api>(() => {
    const empujar = (tono: Tono) => (titulo: string, detalle?: string) => {
      const id = siguienteId++;
      setToasts((t) => [...t, { id, tono, titulo, detalle }]);
    };
    return { ok: empujar("ok"), warn: empujar("warn"), error: empujar("danger") };
  }, []);

  return (
    <Ctx.Provider value={api}>
      {children}
      {/* `aria-live` en el contenedor y no en cada toast: si se anuncia el
          elemento que acaba de insertarse, el lector de pantalla se lo pierde
          —la región tiene que existir ANTES de que llegue el contenido. */}
      <div className="cr-toast-zona" aria-live="polite" aria-atomic="false">
        {toasts.map((t) => (
          <Aviso key={t.id} toast={t} cerrar={cerrar} />
        ))}
      </div>
    </Ctx.Provider>
  );
}

function Aviso({ toast, cerrar }: { toast: Toast; cerrar: (id: number) => void }) {
  const { id, tono } = toast;

  useEffect(() => {
    // TODOS los toasts se van solos, también los de error: misma duración y
    // misma barra de tiempo. Que unos caduquen y otros no obligaba a mirar el
    // aviso para saber si iba a quedarse, y dejaba errores viejos en pantalla.
    // Un fallo que hay que leer con calma va en un <Aviso> de la pantalla, no
    // en un toast.
    const t = setTimeout(() => cerrar(id), DURACION);
    return () => clearTimeout(t);
    // Solo `id`: identifica ESTE toast. Si aquí entrara algo que cambia en cada
    // render, la cuenta atrás se reiniciaría sola.
  }, [id, cerrar]);

  return (
    <div
      className={`cr-toast cr-toast--${tono}${toast.saliendo ? " cr-toast--saliendo" : ""}`}
      role={tono === "danger" ? "alert" : "status"}
    >
      <div className="cr-toast__cuerpo">
        <p className="cr-toast__titulo">{toast.titulo}</p>
        {toast.detalle ? <p className="cr-toast__detalle">{toast.detalle}</p> : null}
      </div>
      <button
        type="button"
        className="cr-toast__cerrar"
        onClick={() => cerrar(id)}
        aria-label="Cerrar"
      >
        <X strokeWidth={1.75} />
      </button>
      {/* La duración sale de la misma constante que el temporizador, para que la
          barra no pueda mentir sobre cuánto queda. */}
      <span
        className="cr-toast__barra"
        style={{ animationDuration: `${DURACION}ms` }}
        aria-hidden="true"
      />
    </div>
  );
}
