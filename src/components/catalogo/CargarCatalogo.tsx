"use client";

import { Upload } from "lucide-react";
import { useRef } from "react";
import { fmtFechaHora } from "@/components/lib/fmt";
import { Meter } from "@/components/ui/basicos";
import type { CargaActiva } from "@/lib/catalogo/tipos";

export type EstadoCarga = "inactivo" | "leyendo" | "subiendo" | "finalizando";

const TEXTO_ESTADO: Record<Exclude<EstadoCarga, "inactivo">, string> = {
  leyendo: "Leyendo archivo…",
  subiendo: "Subiendo…",
  finalizando: "Activando…",
};

/**
 * Botón de carga de la barra de herramientas.
 *
 * No se reutiliza AnalisisUploader: ése es una zona de arrastre de ~10rem
 * pensada como estado vacío de página, y aquí el módulo ya está mostrando datos.
 * Sí se copian sus dos detalles que no son obvios: el reset del input y el
 * aria-busy del botón.
 *
 * Debajo se dice siempre QUÉ archivo está activo. Con reemplazo total es
 * imprescindible: sin esa línea, sustituir el catálogo es indistinguible de que
 * los datos hayan cambiado solos.
 */
export function CargarCatalogo({
  onArchivo,
  estado,
  progreso,
  carga,
}: {
  onArchivo: (file: File) => void;
  estado: EstadoCarga;
  progreso: number;
  carga: CargaActiva | null;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const trabajando = estado !== "inactivo";

  return (
    <div className="flex flex-col items-end gap-1">
      <input
        ref={inputRef}
        id="archivo-catalogo"
        type="file"
        accept=".xlsx"
        className="hidden"
        disabled={trabajando}
        onChange={(e) => {
          const file = e.target.files?.[0];
          // Sin este reset, volver a elegir el MISMO archivo no dispara change
          // y el botón parece no funcionar.
          e.target.value = "";
          if (file) onArchivo(file);
        }}
      />

      <button
        type="button"
        className="cr-btn cr-btn--primary"
        disabled={trabajando}
        aria-busy={trabajando}
        onClick={() => inputRef.current?.click()}
      >
        {trabajando ? (
          <>
            <span className="cr-spin" aria-hidden="true" />
            {TEXTO_ESTADO[estado]}
          </>
        ) : (
          <>
            <Upload strokeWidth={1.75} />
            {carga ? "Cargar otro Excel" : "Cargar Excel"}
          </>
        )}
      </button>

      {estado === "subiendo" ? (
        <div style={{ width: "12rem" }}>
          <Meter value={progreso} tono="ink" />
        </div>
      ) : carga ? (
        /* AutorReporte no sirve aquí: pinta nombre y correo en dos bloques,
           pensado para una celda de tabla. Esto es una línea de pie, así que va
           el nombre, y el correo en el title. */
        <span className="cr-small truncate" style={{ maxWidth: "22rem" }}>
          <span className="cr-mono">{carga.filename}</span>
          {carga.subidaPor ? (
            <span title={carga.subidaPor.email}> · {carga.subidaPor.nombre}</span>
          ) : null}
          {carga.finalizadaEl ? <> · {fmtFechaHora(carga.finalizadaEl)}</> : null}
        </span>
      ) : null}
    </div>
  );
}
