// Valida el markdown de un reporte antes de convertirlo en tarjeta
// descargable. No genera el PDF: eso ocurre en el navegador al descargar,
// así que aquí solo se maneja texto (nada de blobs ni almacenamiento).
//
// Devolver un error legible es parte del diseño: el modelo lo lee y reintenta
// con el contenido corregido.

export interface CrearReporteInput {
  title: string;
  markdown: string;
  fileName?: string;
  summary?: string;
}

export interface ResultadoReporte {
  ok: boolean;
  reporteId?: string;
  title?: string;
  fileName?: string;
  markdown?: string;
  summary?: string;
  caracteres?: number;
  tablas?: number;
  error?: string;
}

const MAX_MARKDOWN = 80_000;
const MIN_MARKDOWN = 40;

function sanearArchivo(name: string): string {
  const base = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  return base || "reporte-cronos";
}

function contarTablas(markdown: string): number {
  return markdown
    .split("\n")
    .filter((l) => l.includes("|") && /^\|?[\s:|-]*-{2,}[\s:|-]*\|?$/.test(l.trim())).length;
}

export function crearReporte(entrada: CrearReporteInput, id: string): ResultadoReporte {
  const title = entrada.title?.trim();
  const markdown = entrada.markdown?.trim();

  if (!title) return { ok: false, error: "El título del reporte es obligatorio." };

  if (!markdown || markdown.length < MIN_MARKDOWN) {
    return {
      ok: false,
      error:
        "El contenido del reporte es demasiado corto. Incluye secciones y tablas con los datos que consultaste.",
    };
  }

  if (markdown.length > MAX_MARKDOWN) {
    return {
      ok: false,
      error: `El reporte excede ${MAX_MARKDOWN.toLocaleString("es-MX")} caracteres. Resume o divide el contenido.`,
    };
  }

  const tablas = contarTablas(markdown);
  if (tablas === 0) {
    return {
      ok: false,
      error:
        "El reporte no incluye ninguna tabla. Presenta los datos consultados en tablas markdown (| Col | Col |).",
    };
  }

  return {
    ok: true,
    reporteId: id,
    title,
    fileName: sanearArchivo(entrada.fileName?.trim() || title.toLowerCase()),
    markdown,
    summary: entrada.summary?.trim() || undefined,
    caracteres: markdown.length,
    tablas,
  };
}
