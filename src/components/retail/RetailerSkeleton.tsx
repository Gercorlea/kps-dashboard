// Esqueleto de la ficha de un retailer (/retail/[retailer]).
//
// La ficha se hace esperar dos veces: primero el servidor (sesión más el
// agregado de Mongo) y luego el cliente, que pide el bundle del retailer y
// carga recharts aparte. Este archivo dibuja la MISMA silueta para las dos, así
// que desde el clic hasta que entran los datos la pantalla no cambia de forma:
// sólo se van llenando los huecos.
//
// Copia la vista `resumen` de RetailerDetalle —la que se pinta al entrar— con el
// cromo real (.cr-detalle-head, .cr-panel, la rejilla de KPIs) y bloques grises
// donde van los datos. Si esa vista cambia de estructura, este archivo también.
//
// Es un componente de servidor: no hay estado, ni recharts, ni iconos. Lo usan
// el loading.tsx de la ruta y el propio RetailerDetalle mientras carga.

/** Hueco de un dato que todavía no llega. */
function Bloque({
  ancho,
  alto,
  className,
}: {
  ancho?: number | string;
  alto: number;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={`cr-skel block${className ? ` ${className}` : ""}`}
      style={{ width: ancho, height: alto }}
    />
  );
}

/**
 * Panel de gráfica: el marco es el de verdad y sólo el contenido es gris. El
 * alto del área lo pasa el llamador con el de la gráfica que va a sustituirla,
 * para que el panel no cambie de tamaño al llegar los datos.
 */
function PanelSkeleton({
  alto,
  sub = true,
  accion = true,
  leyenda = 0,
}: {
  alto: number;
  /** La línea de .cr-viz-sub bajo el título. */
  sub?: boolean;
  /** La cifra o el delta que va a la derecha del título. */
  accion?: boolean;
  /** Ítems de la leyenda bajo la gráfica; 0 = sin leyenda. */
  leyenda?: number;
}) {
  return (
    <section className="cr-panel">
      <header className="cr-panel__head">
        <Bloque ancho={168} alto={12} />
        {accion ? <Bloque ancho={64} alto={18} /> : null}
      </header>
      <div className="cr-panel__body">
        {sub ? <Bloque ancho={208} alto={10} className="mb-3" /> : null}
        <Bloque alto={alto} />
        {leyenda > 0 ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {Array.from({ length: leyenda }, (_, i) => (
              <Bloque key={i} ancho={96} alto={18} />
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}

/**
 * Cabecera de la ficha. Sólo la pinta el loading.tsx: en cuanto responde el
 * servidor, la cabecera de verdad ya tiene sus datos (vienen con la página) y
 * es el contenido el que sigue cargando.
 */
export function RetailerCabeceraSkeleton() {
  return (
    <header className="cr-detalle-head cr-pulse" aria-hidden="true">
      <div className="cr-detalle-head__fila">
        <div className="flex min-w-0 items-center gap-2.5">
          <Bloque ancho={12} alto={12} />
          <Bloque ancho={184} alto={22} />
          <Bloque ancho={88} alto={19} />
        </div>
        <Bloque ancho={140} alto={33} />
      </div>

      <div className="cr-detalle-head__fila">
        <Bloque ancho={152} alto={14} />
        <div className="flex min-w-48 flex-1 items-center gap-3">
          <div className="min-w-24 flex-1">
            <Bloque alto={5} />
          </div>
          <Bloque ancho={132} alto={14} />
        </div>
      </div>

      <div className="cr-detalle-head__tabs">
        <Bloque ancho={312} alto={36} />
        <div className="hidden items-center gap-4 sm:flex">
          {[64, 56, 60].map((ancho) => (
            <div key={ancho} className="flex flex-col items-end gap-1.5">
              <Bloque ancho={ancho} alto={9} />
              <Bloque ancho={72} alto={13} />
            </div>
          ))}
        </div>
      </div>
    </header>
  );
}

/**
 * Las cuatro gráficas del resumen, con los altos reales de AnalisisCharts: el
 * año contra el anterior, la serie por periodo y —pareadas— el ranking de la
 * dimensión y su composición.
 *
 * Sin animación propia: la pone quien lo monta, para que no queden dos
 * `cr-pulse` anidados latiendo desfasados.
 */
export function RetailerGraficasSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <PanelSkeleton alto={248} leyenda={2} />
      <PanelSkeleton alto={240} sub={false} />
      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-2">
        <PanelSkeleton alto={284} accion={false} />
        <PanelSkeleton alto={52} accion={false} leyenda={3} />
      </div>
    </div>
  );
}

/**
 * Contenido de la ficha: los filtros, los KPIs y las gráficas.
 *
 * El `gap-6` de la raíz es el del .cr-page-content de la ficha, así que sirve
 * igual dentro de ella (mientras el cliente carga) que en el loading.tsx.
 */
export function RetailerContenidoSkeleton() {
  return (
    <div className="cr-pulse flex flex-col gap-6" aria-busy="true">
      <span className="sr-only">Cargando la ficha del retailer…</span>

      {/* Los selectores de dimensión, métrica y agregación. */}
      <div className="flex flex-wrap items-end gap-3">
        {[132, 148, 116].map((ancho) => (
          <div key={ancho} className="cr-field">
            <Bloque ancho={Math.round(ancho * 0.55)} alto={9} />
            <Bloque ancho={ancho} alto={37} />
          </div>
        ))}
      </div>

      {/* Misma rejilla que AnalisisKpis. Las tarjetas son .cr-card y no .cr-kpi
          a propósito: la cinta de tinta de 2px del KPI se leería como un dato
          que ya llegó. */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[104, 88, 120, 96].map((ancho) => (
          <div key={ancho} className="cr-card" style={{ padding: "18px 20px" }}>
            <Bloque ancho={ancho} alto={10} />
            <Bloque ancho={144} alto={30} className="mt-2.5" />
          </div>
        ))}
      </div>

      <RetailerGraficasSkeleton />
    </div>
  );
}
