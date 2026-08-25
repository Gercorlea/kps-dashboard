"use client";

// Filtro de periodo de la ficha del retailer: Desde, Hasta y Limpiar, alineados
// a la derecha de la fila de filtros para que no se confundan con los
// selectores de la izquierda, que son de otra clase (esos eligen QUÉ se mira;
// éste, DE CUÁNDO).
//
// Dos `<input type="date">` nativos: no hay Radix ni date-picker en el repo, y
// el nativo ya trae el calendario, el teclado y la validación de min/max que
// habría que reimplementar.
//
// Hacen falta las DOS fechas para que se aplique: elegir sólo la primera deja
// el filtro a medias y no mueve nada. Los `min`/`max` cruzados evitan además que
// por el calendario se pueda armar un rango al revés. En los dos casos el aviso
// de abajo dice qué falta, para que "no pasa nada" no se lea como una avería.

import { type EstadoPeriodo, type RangoISO } from "@/lib/retail/analisis/periodos";

/** Qué se dice cuando lo escrito todavía no se puede aplicar. */
const AVISO: Partial<Record<EstadoPeriodo, string>> = {
  invertido: "El inicio del periodo es posterior al fin.",
};

export function SelectorPeriodo({
  rangoDatos,
  desde,
  hasta,
  estado,
  onCambio,
}: {
  /** Rango con datos del retailer (`bundle.rangoFechas`), para los topes. */
  rangoDatos: RangoISO;
  /** Lo que hay escrito en cada input. */
  desde: string;
  hasta: string;
  /** Lo que dice `estadoDelPeriodo` de esas dos fechas. */
  estado: EstadoPeriodo;
  onCambio: (desde: string, hasta: string) => void;
}) {
  const aviso = AVISO[estado];

  return (
    <div className="flex flex-wrap items-end gap-3 sm:ml-auto">
      <label className="cr-field">
        <span className="cr-label">Desde</span>
        <input
          type="date"
          className="cr-input"
          value={desde}
          min={rangoDatos.desde}
          max={hasta || rangoDatos.hasta}
          onChange={(e) => onCambio(e.target.value, hasta)}
        />
      </label>

      <label className="cr-field">
        <span className="cr-label">Hasta</span>
        <input
          type="date"
          className="cr-input"
          value={hasta}
          min={desde || rangoDatos.desde}
          max={rangoDatos.hasta}
          onChange={(e) => onCambio(desde, e.target.value)}
        />
      </label>

      {desde || hasta ? (
        <button
          type="button"
          className="cr-btn cr-btn--secondary cr-btn--sm"
          onClick={() => onCambio("", "")}
        >
          Limpiar
        </button>
      ) : null}

      {aviso ? (
        <p
          className="cr-small basis-full sm:basis-auto"
          // Falta una fecha es un paso a medias, no un error: sólo el rango al
          // revés —que sí es algo que hay que corregir— se pinta en rojo.
          style={estado === "invertido" ? { color: "var(--cr-danger)" } : undefined}
          role={estado === "invertido" ? "alert" : "status"}
        >
          {aviso}
        </p>
      ) : null}
    </div>
  );
}
