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
      {acciones ? <div className="flex items-center gap-2">{acciones}</div> : null}
    </div>
  );
}
