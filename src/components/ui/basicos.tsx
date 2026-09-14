import type { ReactNode } from "react";

// Wrappers finos sobre las clases del design system (§4.5). El CSS vive
// en design-system.css; aquí solo se componen clases.

export function Badge({
  tono = "neutro",
  children,
}: {
  tono?: "ok" | "warn" | "danger" | "ai" | "neutro";
  children: ReactNode;
}) {
  const mod = tono === "neutro" ? "" : ` cr-badge--${tono}`;
  return <span className={`cr-badge${mod}`}>{children}</span>;
}

export function Kpi({
  label,
  value,
  alerta = false,
  positivo = false,
  detalle,
}: {
  label: string;
  value: ReactNode;
  alerta?: boolean;
  positivo?: boolean;
  detalle?: ReactNode;
}) {
  const mod = alerta ? " cr-kpi--alert" : positivo ? " cr-kpi--positivo" : "";
  return (
    <div className={`cr-kpi${mod}`}>
      <div className="cr-kpi__label">{label}</div>
      <div className="cr-kpi__value">{value}</div>
      {detalle ? <div className="cr-small mt-1">{detalle}</div> : null}
    </div>
  );
}

export function Panel({
  title,
  subtitulo,
  acciones,
  children,
  sinPadding = false,
}: {
  title?: ReactNode;
  /**
   * Línea meta bajo el título: el conteo, el periodo, la cobertura. Es donde va
   * el dato que si no acabaría inventándose un encabezado de sub-sección propio.
   */
  subtitulo?: ReactNode;
  acciones?: ReactNode;
  children: ReactNode;
  sinPadding?: boolean;
}) {
  return (
    <section className="cr-panel">
      {title !== undefined ? (
        <header className="cr-panel__head">
          <div className="min-w-0">
            <h3 className="cr-h3">{title}</h3>
            {subtitulo ? <p className="cr-small cr-ink-3">{subtitulo}</p> : null}
          </div>
          {acciones}
        </header>
      ) : null}
      {sinPadding ? children : <div className="cr-panel__body">{children}</div>}
    </section>
  );
}

/**
 * Tabla de datos. Pone el envoltorio con scroll y la clase de la tabla, que es
 * la pareja que se escribía a mano en ocho archivos.
 *
 * El scroll NO es opcional: sin `.cr-table-scroll` una tabla más ancha que la
 * pantalla empuja el panel y la barra horizontal acaba saliendo en el documento
 * en vez de en la tabla.
 *
 * Va dentro de un <Panel sinPadding> — el panel da el marco, la tabla su
 * propio padding por celda.
 *
 *   <Panel title="Ranking" sinPadding>
 *     <Tabla densidad="comoda">
 *       <thead>…</thead>
 *       <tbody>…</tbody>
 *     </Tabla>
 *   </Panel>
 */
export function Tabla({
  densidad = "normal",
  headLg = false,
  scroll = false,
  fija = false,
  children,
}: {
  /**
   * - `normal`: el default, calibrado para tablas anchas (el histórico de
   *   retail llega a sesenta columnas).
   * - `comoda`: para tablas de pocas columnas, que a la densidad normal se ven
   *   dispersas. Sustituye a los `style={{ padding }}` por página.
   * - `compacta`: listas densas donde cada píxel de alto es una fila más.
   */
  densidad?: "normal" | "comoda" | "compacta";
  /** Encabezados a 11px en vez de 9px. */
  headLg?: boolean;
  /**
   * Scroll horizontal. Va APAGADO por defecto a propósito: la regla es
   * compactar hasta que la tabla quepa, no dejar que se desborde de lado. Se
   * enciende solo donde el ancho es irreducible —el histórico de retail, que
   * llega a sesenta columnas de fechas—, nunca para no tener que compactar.
   */
  scroll?: boolean;
  /**
   * Anchos mandados por `<colgroup>` (`table-layout: fixed`) en vez de
   * calculados por el contenido. **Necesario para que `truncate` funcione**: sin
   * esto una celda larga ensancha su columna y empuja la tabla, y lo que sale es
   * scroll horizontal en vez de puntos suspensivos.
   */
  fija?: boolean;
  children: ReactNode;
}) {
  const clases = ["cr-table"];
  if (densidad === "comoda") clases.push("cr-table--comoda");
  if (densidad === "compacta") clases.push("cr-table--compact");
  if (headLg) clases.push("cr-table--head-lg");
  if (fija) clases.push("cr-table--fija");
  const tabla = <table className={clases.join(" ")}>{children}</table>;
  return scroll ? <div className="cr-table-scroll">{tabla}</div> : tabla;
}

/**
 * Campo de formulario: etiqueta arriba, control debajo.
 *
 * Envuelve en `<label>`, así que el control queda asociado a su etiqueta sin
 * necesidad de `id` + `htmlFor` —hacer clic en el texto enfoca el campo y un
 * lector de pantalla lo anuncia—. Por eso mismo NO sirve para un grupo de
 * radios o checkboxes: ahí la etiqueta pertenece al grupo, no a un control, y
 * va un `<fieldset>` con `.cr-radios`.
 *
 *   <Campo label="Correo">
 *     <input className="cr-input" type="email" />
 *   </Campo>
 */
export function Campo({
  label,
  ayuda,
  children,
}: {
  label: ReactNode;
  /** Texto de apoyo bajo el control: formato esperado, límites, etc. */
  ayuda?: ReactNode;
  children: ReactNode;
}) {
  return (
    <label className="cr-field">
      <span className="cr-label">{label}</span>
      {children}
      {ayuda ? <span className="cr-small">{ayuda}</span> : null}
    </label>
  );
}

export function Meter({
  value,
  tono = "ok",
}: {
  value: number; // 0..1
  tono?: "ok" | "warn" | "danger" | "ink";
}) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  const mod = tono === "ok" ? "" : ` cr-meter__fill--${tono}`;
  return (
    <div className="cr-meter" role="progressbar" aria-valuenow={Math.round(pct)}>
      <div className={`cr-meter__fill${mod}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

/**
 * Caja de mensaje de estado: motivo arriba, qué hacer debajo.
 *
 * Con `tono="danger"` se anuncia como `role="alert"`; los otros tonos son
 * informativos y no interrumpen a un lector de pantalla.
 */
export function Aviso({
  tono = "neutro",
  titulo,
  icono,
  children,
}: {
  tono?: "danger" | "warn" | "ok" | "neutro";
  titulo: ReactNode;
  icono?: ReactNode;
  children?: ReactNode;
}) {
  const mod = tono === "neutro" ? "" : ` cr-aviso--${tono}`;
  return (
    <div className={`cr-aviso${mod}`} role={tono === "danger" ? "alert" : undefined}>
      {icono ? (
        <span className="cr-aviso__icono" aria-hidden="true">
          {icono}
        </span>
      ) : null}
      <div className="cr-aviso__cuerpo">
        <p className="cr-aviso__titulo">{titulo}</p>
        {children ? <div className="cr-aviso__detalle">{children}</div> : null}
      </div>
    </div>
  );
}

export function EstadoVacio({
  title,
  detalle,
  children,
}: {
  title: string;
  detalle?: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
      {children}
      <p className="cr-h3">{title}</p>
      {detalle ? <p className="cr-body max-w-sm">{detalle}</p> : null}
    </div>
  );
}
