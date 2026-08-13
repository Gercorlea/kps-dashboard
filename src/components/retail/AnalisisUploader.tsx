import { FileSpreadsheet, Upload } from "lucide-react";
import { useRef, useState } from "react";

interface Props {
  onArchivo: (file: File) => void;
  cargando: boolean;
  nombreArchivo: string | null;
}

// Selector de archivo para el análisis exploratorio. A diferencia de
// <Uploader>, no sube nada: el .xlsx se parsea en el navegador y no sale del
// equipo (§7 bis). Por eso tampoco hay barra de progreso ni fecha de corte.
export function AnalisisUploader({ onArchivo, cargando, nombreArchivo }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [arrastrando, setArrastrando] = useState(false);

  function tomar(file: File | undefined) {
    if (file) onArchivo(file);
  }

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setArrastrando(true);
      }}
      onDragLeave={() => setArrastrando(false)}
      onDrop={(e) => {
        e.preventDefault();
        setArrastrando(false);
        if (!cargando) tomar(e.dataTransfer.files[0]);
      }}
      className="flex flex-col items-center gap-3 border border-dashed px-6 py-10 text-center"
      style={{
        borderColor: arrastrando ? "var(--cr-ink)" : "var(--cr-line-2)",
        background: arrastrando ? "var(--cr-surface-3)" : "var(--cr-surface-2)",
        borderRadius: "var(--cr-r-sm)",
      }}
    >
      <FileSpreadsheet size={28} strokeWidth={1.5} style={{ color: "var(--cr-ink-3)" }} />

      <div className="flex flex-col gap-1">
        <p className="cr-body">
          {nombreArchivo && !cargando
            ? nombreArchivo
            : "Arrastra un Excel o selecciónalo para analizarlo"}
        </p>
        <span className="cr-small">
          Solo .xlsx · se procesa en tu navegador, no se sube a ningún servidor
        </span>
      </div>

      {/* El input nativo no se puede estilizar: se oculta y el botón lo dispara. */}
      <input
        ref={inputRef}
        id="archivo-analisis"
        type="file"
        accept=".xlsx"
        className="hidden"
        disabled={cargando}
        onChange={(e) => {
          const file = e.target.files?.[0];
          // Sin este reset, volver a elegir el MISMO archivo no dispara change.
          e.target.value = "";
          tomar(file);
        }}
      />
      <button
        type="button"
        className="cr-btn cr-btn--primary"
        disabled={cargando}
        aria-busy={cargando}
        onClick={() => inputRef.current?.click()}
      >
        {cargando ? (
          <>
            <span className="cr-spin" aria-hidden="true" />
            Leyendo archivo…
          </>
        ) : (
          <>
            <Upload strokeWidth={1.75} />
            {nombreArchivo ? "Cargar otro archivo" : "Cargar archivo Excel"}
          </>
        )}
      </button>
    </div>
  );
}
