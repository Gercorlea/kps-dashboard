"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/** Altos de respaldo para la PRIMERA medida, cuando la tabla y el pie aún no existen. */
const ENCABEZADO_ESTIMADO = 34;
const PIE_ESTIMADO = 53;
/** Bordes del panel y redondeo del layout. */
const MARGEN = 4;

/**
 * Cuántas filas caben en pantalla sin que haya que hacer scroll para llegar al
 * pie de la lista.
 *
 * POR QUE NO UN NUMERO FIJO. Un tamaño de página escrito a mano solo acierta en
 * una pantalla: doce filas se ven bien al 80% de zoom y al 100% el paginador cae
 * bajo el pliegue. El alto disponible depende del alto de la ventana, del zoom y
 * de dónde empiece la lista en el documento —que cambia si la cabecera crece o
 * aparece un aviso—, así que se mide en vez de adivinarse.
 *
 * COMO SE USA: el `ancla` va en el elemento donde EMPIEZAN las filas (el
 * contenedor de la tabla, ya debajo de la cabecera del panel). Desde su borde
 * superior hasta el fondo de la ventana está todo lo que se puede llenar.
 *
 *   const { ancla, filas } = useFilasQueCaben({ altoFila: 41, recalcularCon: [datos] });
 *   …
 *   <div ref={ancla}><Tabla>…</Tabla></div>
 *
 * `filas` es `null` hasta la primera medida: espera a que sea un número antes de
 * pedir la primera página, o pedirás dos veces.
 *
 * TODO LO QUE HAY QUE DESCONTAR —y por qué se MIDE en vez de estimarse—. Entre
 * el borde superior del ancla y el fondo de la ventana no solo hay filas:
 *
 *  - el `<thead>`, que no es una fila de datos;
 *  - la **barra de scroll horizontal** de la tabla, cuando la hay: ocupa unos
 *    15px de ALTO y es justo el "scroll poquito" que aparece si no se cuenta;
 *  - el pie de paginación;
 *  - el respiro inferior de `.cr-page-content`.
 *
 * Los cuatro se leen del DOM. Estimarlos con constantes deja la cuenta corta por
 * unos píxeles, y unos píxeles son exactamente una barra de scroll de página —
 * que es lo que este hook existe para evitar.
 *
 * LA TRAMPA DE LA PRIMERA MEDIDA. En el primer render todavía no hay `<thead>`
 * ni pie —lo que se ve es el "cargando"—, así que ahí sí se usan los valores de
 * respaldo y se vuelve a medir en cuanto llegan los datos: para eso está
 * `recalcularCon`.
 *
 * El zoom del navegador dispara `resize`, así que se reajusta solo. Y como
 * `setFilas` recibe el mismo número cuando el resultado no cambia, React corta
 * el re-render: mover la ventana no provoca refetch salvo que de verdad quepa
 * otra fila.
 */
export function useFilasQueCaben({
  altoFila,
  minimo = 3,
  maximo = 40,
  /** Valores que, al cambiar, obligan a volver a medir (típicamente los datos). */
  recalcularCon = [],
}: {
  /** Alto estimado de una fila, solo para la primera pasada: luego se mide. */
  altoFila: number;
  minimo?: number;
  maximo?: number;
  recalcularCon?: unknown[];
}) {
  const ancla = useRef<HTMLDivElement | null>(null);
  const [filas, setFilas] = useState<number | null>(null);

  const medir = useCallback(() => {
    const el = ancla.current;
    if (!el) return;

    const thead = el.querySelector("thead");
    const altoEncabezado = thead?.getBoundingClientRect().height || ENCABEZADO_ESTIMADO;

    // Barra de scroll horizontal de la tabla: la diferencia entre el alto de la
    // caja y el alto de su contenido visible. Cero cuando no hay barra.
    const scroller = el.querySelector<HTMLElement>(".cr-table-scroll");
    const barraHorizontal = scroller ? scroller.offsetHeight - scroller.clientHeight : 0;

    // El pie vive fuera del ancla pero dentro del mismo panel.
    const pie = el.parentElement?.querySelector<HTMLElement>("[data-paginacion]");
    const altoPie = pie?.getBoundingClientRect().height || PIE_ESTIMADO;

    const contenido = el.closest<HTMLElement>(".cr-page-content");
    const respiro = contenido
      ? parseFloat(getComputedStyle(contenido).paddingBottom) || 0
      : 24;

    // El alto REAL de una fila pintada. `altoFila` es solo la estimación para
    // la primera pasada: en cuanto hay una fila en el DOM manda la medida, que
    // es lo único que sabe del alto de los controles que lleve dentro.
    const primera = el.querySelector<HTMLElement>("tbody tr");
    const alto = primera?.getBoundingClientRect().height || altoFila;

    const arriba = el.getBoundingClientRect().top;
    const disponible =
      window.innerHeight - arriba - altoEncabezado - barraHorizontal - altoPie - respiro - MARGEN;

    const caben = Math.floor(disponible / alto);
    setFilas(Math.max(minimo, Math.min(maximo, caben)));
  }, [altoFila, minimo, maximo]);

  // useLayoutEffect: mide antes de pintar, así no se ve el salto de una lista
  // que se dimensiona después de aparecer.
  useLayoutEffect(() => {
    medir();
    window.addEventListener("resize", medir);
    return () => window.removeEventListener("resize", medir);
  }, [medir]);

  useEffect(() => {
    medir();
    // Las dependencias las decide el consumidor: son los datos cuya llegada
    // cambia lo que hay dentro del ancla.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, recalcularCon);

  return { ancla, filas };
}
