import { BrandMark } from "./BrandMark";

/** Indicador de contenido compartido; el spinner se reserva para acciones. */
export function Cargando({ label, compacto = false }: { label: string; compacto?: boolean }) {
  return (
    <div className={`cr-cargando${compacto ? " cr-cargando--compacto" : ""}`} role="status">
      <span className="cr-cargando__marca" aria-hidden="true"><BrandMark height={compacto ? 24 : 56} /></span>
      <span className="cr-small">{label}</span>
    </div>
  );
}
