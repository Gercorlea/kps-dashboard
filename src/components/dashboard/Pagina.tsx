import type { ReactNode } from "react";
import { PageHeader } from "./PageHeader";

/**
 * El marco de una pantalla. TODA pantalla del dashboard se arma con esto.
 *
 * POR QUE EXISTE. Antes cada página repetía a mano la misma pareja —cabecera
 * más contenedor— y ninguna la escribía igual: unas ponían `flex flex-col
 * gap-5`, otras `gap-8`, otras nada, y dos arrastraban un
 * `cr-page-content--pegado` que no existía en el CSS. El resultado es que el
 * aire entre bloques dependía de qué página abrieras. Aquí el marco se decide
 * una vez y las pantallas dejan de poder equivocarse.
 *
 * QUE RESUELVE POR TI. El padding de la página (que en KPS lo pone
 * `.cr-page-content`, no el layout — ver lib/docs/DESIGN.md §5), el ritmo
 * vertical entre bloques y la cabecera con su título, descripción y acciones.
 *
 * COMO SE USA:
 *
 *   <Pagina title="Peticiones" description="Facturas pendientes de decisión">
 *     <Panel title="Bandeja">…</Panel>
 *     <Panel title="Archivadas">…</Panel>
 *   </Pagina>
 *
 * NO le pongas `p-*`, `max-w-*`, `mx-auto` ni `bg-*` a lo que metas dentro: el
 * contenido va a ancho completo y el padding ya está puesto. Si crees que una
 * pantalla necesita otra medida, es una decisión de diseño — se cambia en
 * `design-system.css` para todas, no en una página suelta.
 *
 * CUANDO NO USARLO. Las pantallas que ocupan el alto completo y traen su propio
 * marco: el chat (`ChatShell`) y la ficha de retailer (`RetailerDetalle`, que
 * usa `.cr-detalle-head` porque lleva pestañas pegadas a la cabecera).
 */
export function Pagina({
  title,
  description,
  acciones,
  ritmo = "normal",
  children,
}: {
  title: string;
  description?: string;
  /** Botones o controles a la derecha del título. */
  acciones?: ReactNode;
  /**
   * Separación entre los bloques de la página.
   * - `normal` (20px): el caso por defecto — los bloques se leen como una lista.
   * - `amplio` (32px): los bloques son unidades independientes entre sí.
   *
   * Son los dos únicos ritmos a propósito. Si ninguno encaja, el arreglo va en
   * el design system, no aquí.
   */
  ritmo?: "normal" | "amplio";
  children: ReactNode;
}) {
  // La cabecera va DENTRO del área de contenido: sin franja ni recuadro, sobre
  // el lienzo, arrancando en la misma vertical que los paneles de abajo.
  return (
    <div className={`cr-page-content cr-stack${ritmo === "amplio" ? " cr-stack--amplio" : ""}`}>
      <PageHeader title={title} description={description} acciones={acciones} />
      {children}
    </div>
  );
}
