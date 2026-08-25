import { FileSpreadsheet, Upload } from "lucide-react";
import { useRef, useState } from "react";

interface Props {
  onArchivo: (file: File) => void;
  cargando: boolean;
  nombreArchivo: string | null;
  /** Letra chica bajo el título: quién se queda con lo que se cargue. */
  nota: string;
}

// Selector de archivo del analizador. A diferencia de <Uploader>, el .xlsx no
// viaja: se parsea en el navegador (§7 bis) y lo que se manda al servidor son
// las filas normalizadas, ya sin el archivo. Por eso no hay fecha de corte, y
// el progreso de la escritura lo pinta el panel del histórico, no esta caja.
export function AnalisisUploader({ onArchivo, cargando, nombreArchivo, nota }: Props) {
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
        <span className="cr-small">{nota}</span>
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
