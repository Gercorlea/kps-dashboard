"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";

/**
 * Diálogo modal. Es la base para todo lo que interrumpe: alta de usuario,
 * confirmar el rechazo de una factura, firmar una aprobación.
 *
 * QUE APORTA SOBRE ESCRIBIR EL MARKUP A MANO. El único modal que había en el
 * proyecto era markup suelto: se podía cerrar solo con su botón, no se
 * anunciaba como diálogo y el foco se quedaba donde estuviera. Aquí eso viene
 * resuelto:
 *
 *  - `role="dialog"` + `aria-modal` + `aria-labelledby` apuntando al título,
 *    para que un lector de pantalla diga qué se abrió.
 *  - Escape cierra.
 *  - Clic en el fondo cierra —pero solo en el fondo: un `mousedown` que empieza
 *    dentro de la caja y termina fuera (seleccionar texto y soltar) NO cierra,
 *    que es el bug clásico de cerrar por `onClick` del backdrop.
 *  - El foco entra a la caja al abrir y vuelve a donde estaba al cerrar.
 *
 * LO QUE NO HACE: no atrapa el tabulador dentro del diálogo. Con el foco puesto
 * en la caja y Escape disponible alcanza para los formularios de hoy; si algún
 * modal crece hasta necesitarlo, el trap se añade AQUI y lo heredan todos.
 *
 *   <Modal titulo="Nuevo usuario" onCerrar={() => setForm(null)}
 *          pie={<><button className="cr-btn cr-btn--ghost" …>Cancelar</button>
 *                 <button className="cr-btn cr-btn--primary" …>Guardar</button></>}>
 *     <Campo label="Nombre"><input className="cr-input" /></Campo>
 *   </Modal>
 *
 * Para un formulario, pasa `como="form"` y `onSubmit`: así el Enter en un campo
 * envía, que es lo que la gente espera de un diálogo con campos.
 */
export function Modal({
  titulo,
  subtitulo,
  children,
  pie,
  onCerrar,
  como = "div",
  onSubmit,
}: {
  titulo: ReactNode;
  /**
   * Línea de identificación bajo el título: de quién es, cuánto es, en qué
   * estado está. Va en la CABECERA y no en el cuerpo — el cuerpo es para la
   * consecuencia y para lo que haya que capturar, no para repetir de qué se
   * está hablando.
   */
  subtitulo?: ReactNode;
  children: ReactNode;
  /** Botones de acción. Van alineados a la derecha, el primario al final. */
  pie?: ReactNode;
  /** Cerrar sin confirmar: Escape, clic en el fondo, botón de cancelar. */
  onCerrar: () => void;
  /** `form` cuando el modal captura datos, para que Enter envíe. */
  como?: "div" | "form";
  onSubmit?: (e: React.FormEvent<HTMLFormElement>) => void;
}) {
  const tituloId = useId();
  const caja = useRef<HTMLElement>(null);
  // Dónde empezó el arrastre. Si empezó dentro de la caja, soltar fuera no
  // debe cerrar: eso es seleccionar texto, no descartar el diálogo.
  const inicioDentro = useRef(false);

  // El `onCerrar` de turno, sin que su identidad entre en las dependencias.
  const cerrarRef = useRef(onCerrar);
  useEffect(() => {
    cerrarRef.current = onCerrar;
  }, [onCerrar]);

  // Montaje y desmontaje, NADA MAS.
  //
  // Antes dependía de `onCerrar`, y quien abre el modal lo escribe casi siempre
  // como una lambda —`onCerrar={() => setAbierto(null)}`—, así que cambia de
  // identidad en cada render. Escribir una letra en un campo re-renderiza al
  // padre → nuevo `onCerrar` → el efecto se limpia y se vuelve a montar → la
  // limpieza devuelve el foco al elemento que lo tenía ANTES de abrir el modal.
  // Resultado: el campo perdía el foco a la primera tecla y no se podía escribir.
  useEffect(() => {
    const previo = document.activeElement as HTMLElement | null;
    caja.current?.focus();

    function alTeclear(e: KeyboardEvent) {
      if (e.key === "Escape") cerrarRef.current();
    }
    document.addEventListener("keydown", alTeclear);
    return () => {
      document.removeEventListener("keydown", alTeclear);
      previo?.focus?.();
    };
  }, []);

  // Atributos comunes a las dos formas de la caja. Se escriben una vez para que
  // la variante `form` no pueda quedarse sin el `role` o sin el foco.
  const propsCaja = {
    className: "cr-modal__caja",
    role: "dialog",
    "aria-modal": true,
    "aria-labelledby": tituloId,
    tabIndex: -1,
  } as const;

  const contenido = (
    <>
      <div className="cr-modal__head">
        {/* `.cr-h3` y no `.cr-h2`: el titular de un diálogo es el de un panel,
            no el de una pantalla. A 19px competía con el contenido. */}
        <h2 className="cr-h3" id={tituloId}>
          {titulo}
        </h2>
        {subtitulo ? <p className="cr-small cr-ink-3">{subtitulo}</p> : null}
      </div>
      <div className="cr-modal__cuerpo">{children}</div>
      {pie ? <div className="cr-modal__pie">{pie}</div> : null}
    </>
  );

  return (
    <div
      className="cr-modal"
      onMouseDown={(e) => {
        inicioDentro.current = e.target !== e.currentTarget;
      }}
      onMouseUp={(e) => {
        if (e.target === e.currentTarget && !inicioDentro.current) onCerrar();
      }}
    >
      {como === "form" ? (
        <form
          {...propsCaja}
          ref={caja as React.RefObject<HTMLFormElement | null>}
          onSubmit={onSubmit}
        >
          {contenido}
        </form>
      ) : (
        <div {...propsCaja} ref={caja as React.RefObject<HTMLDivElement | null>}>
          {contenido}
        </div>
      )}
    </div>
  );
}
