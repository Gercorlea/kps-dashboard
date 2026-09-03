import type { ReactNode } from "react";

export function PageHeader({
  title,
  description,
  acciones,
}: {
  title: string;
  description?: string;
  acciones?: ReactNode;
}) {
  return (
    <div className="cr-page-head">
      <div>
        <h1 className="cr-h1">{title}</h1>
        {description ? <p className="cr-body mt-0.5">{description}</p> : null}
      </div>
      {/* flex-wrap: en movil el grupo de acciones —un segmentado y dos
          botones— no cabe en una linea, y sin envolver empujaba el ancho de
          la cabecera por encima del de la pantalla. */}
      {acciones ? <div className="flex flex-wrap items-center gap-2">{acciones}</div> : null}
    </div>
  );
}
