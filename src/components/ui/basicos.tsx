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
  detalle,
}: {
  label: string;
  value: ReactNode;
  alerta?: boolean;
  detalle?: ReactNode;
}) {
  return (
    <div className={`cr-kpi${alerta ? " cr-kpi--alert" : ""}`}>
      <div className="cr-kpi__label">{label}</div>
      <div className="cr-kpi__value">{value}</div>
      {detalle ? <div className="cr-small mt-1">{detalle}</div> : null}
    </div>
  );
}

export function Panel({
  title,
  acciones,
  children,
  sinPadding = false,
}: {
  title?: ReactNode;
  acciones?: ReactNode;
  children: ReactNode;
  sinPadding?: boolean;
}) {
  return (
    <section className="cr-panel">
      {title !== undefined ? (
        <header className="cr-panel__head">
          <h3 className="cr-h3">{title}</h3>
          {acciones}
        </header>
      ) : null}
      {sinPadding ? children : <div className="cr-panel__body">{children}</div>}
    </section>
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
  tono?: "danger" | "warn" | "neutro";
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
