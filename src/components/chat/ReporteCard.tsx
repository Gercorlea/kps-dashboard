"use client";

import { useState } from "react";
import { Download, FileText, Loader2 } from "lucide-react";
import type { ResultadoReporte } from "@/lib/reportes/crear-reporte";

// El PDF se arma en el navegador al pulsar Descargar: en el chat solo viaja
// el markdown. Así no guardamos archivos ni pagamos almacenamiento, y el
// usuario puede volver a descargarlo cuando quiera.
export function ReporteCard({ reporte }: { reporte: ResultadoReporte }) {
  const [generando, setGenerando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!reporte.ok) {
    return (
      <div className="cr-reporte cr-reporte--error">
        <FileText size={15} aria-hidden />
        <span>No se pudo generar el reporte: {reporte.error}</span>
      </div>
    );
  }

  const descargar = async () => {
    setGenerando(true);
    setError(null);
    try {
      // Import dinámico: react-pdf pesa, y solo hace falta al descargar.
      const [{ pdf }, { ReportePdf }] = await Promise.all([
        import("@react-pdf/renderer"),
        import("@/lib/reportes/ReportePdf"),
      ]);
      const generadoEl = new Intl.DateTimeFormat("es-MX", {
        dateStyle: "long",
        timeStyle: "short",
        timeZone: "America/Mexico_City",
      }).format(new Date());

      const blob = await pdf(
        <ReportePdf
          title={reporte.title ?? "Reporte"}
          markdown={reporte.markdown ?? ""}
          generadoEl={generadoEl}
        />
      ).toBlob();

      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${reporte.fileName ?? "reporte"}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      // Red de seguridad: si el PDF falla, al menos entregamos el contenido
      // en markdown en vez de dejar al usuario sin nada.
      setError(
        `${e instanceof Error ? e.message : "No se pudo generar el PDF"} — se descargó el contenido en .md`
      );
      const md = new Blob([reporte.markdown ?? ""], { type: "text/markdown" });
      const url = URL.createObjectURL(md);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${reporte.fileName ?? "reporte"}.md`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setGenerando(false);
    }
  };

  return (
    <div className="cr-reporte">
      <div className="cr-reporte__icono" aria-hidden>
        <FileText size={16} />
      </div>
      <div className="cr-reporte__cuerpo">
        <p className="cr-reporte__titulo">{reporte.title}</p>
        {reporte.summary ? <p className="cr-reporte__resumen">{reporte.summary}</p> : null}
        <p className="cr-reporte__meta">
          PDF · {reporte.tablas} {reporte.tablas === 1 ? "tabla" : "tablas"}
        </p>
        {error ? (
          <p className="cr-reporte__error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
      <button type="button" className="cr-reporte__boton" onClick={descargar} disabled={generando}>
        {generando ? (
          <Loader2 size={13} className="cr-reporte__spin" aria-hidden />
        ) : (
          <Download size={13} aria-hidden />
        )}
        {generando ? "Generando…" : "Descargar"}
      </button>
    </div>
  );
}
