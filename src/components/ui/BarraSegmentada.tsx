"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";

export interface OpcionSegmentada<T extends string> {
  id: T;
  etiqueta: string;
}

/**
 * Barra de pestañas con la pastilla activa deslizándose de una a otra en vez de
 * saltar.
 *
 * El fondo tinta deja de pintarlo el botón activo y pasa a ser un elemento
 * aparte que se coloca por medida —no hay forma de animar entre dos elementos
 * distintos—, así que hay que leer del DOM dónde está y cuánto ocupa la pestaña
 * viva. Como esas medidas no existen en el servidor, hasta la primera hay dos
 * relevos: `medido` cede el fondo del botón al indicador, y `anima` habilita el
 * movimiento un frame más tarde para que colocarse no se vea como deslizarse.
 *
 * Nació dentro de RetailerDetalle como `BarraVistas`. Se extrajo al añadir el
 * módulo de catálogo: copiar estas medidas en dos sitios habría dejado dos
 * versiones del mismo ajuste fino divergiendo con el tiempo.
 */
export function BarraSegmentada<T extends string>({
  opciones,
  valor,
  onCambio,
  etiqueta,
}: {
  opciones: readonly OpcionSegmentada<T>[];
  valor: T;
  onCambio: (v: T) => void;
  /** Para el lector de pantalla, cuando la barra no tiene un título cerca. */
  etiqueta?: string;
}) {
  const pistaRef = useRef<HTMLDivElement | null>(null);
  const botonesRef = useRef<(HTMLButtonElement | null)[]>([]);
  const [pastilla, setPastilla] = useState({ x: 0, w: 0 });
  const [medido, setMedido] = useState(false);
  const [anima, setAnima] = useState(false);

  // Antes de pintar: si se midiera en un efecto normal se vería un frame con la
  // pastilla en el sitio viejo. El observer la recoloca cuando cambia el ancho
  // —breakpoints del shell, o la fuente que termina de cargar y reajusta las
  // etiquetas—, porque las medidas de entonces ya no sirven.
  useLayoutEffect(() => {
    const medir = () => {
      const activo = botonesRef.current[opciones.findIndex((o) => o.id === valor)];
      const pista = pistaRef.current;
      if (!activo || !pista) return;
      const caja = activo.getBoundingClientRect();
      const cajaPista = pista.getBoundingClientRect();
      setPastilla({ x: caja.left - cajaPista.left, w: caja.width });
      setMedido(true);
    };
    medir();

    const pista = pistaRef.current;
    if (!pista) return;
    const observer = new ResizeObserver(medir);
    observer.observe(pista);
    return () => observer.disconnect();
  }, [valor, opciones]);

  useEffect(() => {
    if (!medido || anima) return;
    const id = requestAnimationFrame(() => setAnima(true));
    return () => cancelAnimationFrame(id);
  }, [medido, anima]);

  return (
    <div
      className={`cr-segment cr-segment--desliza${medido ? " cr-segment--medido" : ""}${
        anima ? " cr-segment--anima" : ""
      }`}
      role="tablist"
      aria-label={etiqueta}
    >
      <div className="cr-segment__pista" ref={pistaRef}>
        <span
          className="cr-segment__indicador"
          aria-hidden
          style={{ transform: `translateX(${pastilla.x}px)`, width: pastilla.w }}
        />
        {opciones.map((o, i) => (
          <button
            key={o.id}
            ref={(el) => {
              botonesRef.current[i] = el;
            }}
            type="button"
            role="tab"
            aria-selected={valor === o.id}
            onClick={() => onCambio(o.id)}
            className={`cr-segment__item${valor === o.id ? " cr-segment__item--active" : ""}`}
          >
            {o.etiqueta}
          </button>
        ))}
      </div>
    </div>
  );
}
