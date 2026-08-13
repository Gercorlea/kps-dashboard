// Parser de markdown a bloques, para renderizar reportes en PDF.
// react-pdf no entiende HTML ni markdown: hay que darle componentes, así que
// primero convertimos el texto del modelo a una lista plana de bloques.
// Subconjunto deliberado: portada, títulos, párrafos, tablas y listas.
// Sin gráficas ni imágenes.

export interface MetricaPortada {
  value: string;
  unidad?: string;
  etiqueta: string;
}

export interface PortadaSpec {
  title: string;
  subtitulo?: string;
  metricas?: MetricaPortada[];
}

export type Alineacion = "left" | "right" | "center";

export type Bloque =
  | { tipo: "portada"; spec: PortadaSpec }
  | { tipo: "title"; nivel: 1 | 2 | 3; texto: string; numero?: string }
  | { tipo: "parrafo"; texto: string }
  | { tipo: "tabla"; encabezados: string[]; filas: string[][]; alineacion: Alineacion[] }
  | { tipo: "lista"; ordenada: boolean; items: string[] }
  | { tipo: "separador" };

const SEPARADOR_TABLA = /^\|?[\s:|-]*-{2,}[\s:|-]*\|?$/;

function esSeparadorTabla(linea: string): boolean {
  const l = linea.trim();
  return l.includes("-") && l.includes("|") && SEPARADOR_TABLA.test(l);
}

function celdas(linea: string): string[] {
  return linea
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

// ":---:" → center, "---:" → right, resto left.
function alineacionesDe(separador: string): Alineacion[] {
  return celdas(separador).map((c) => {
    const der = c.endsWith(":");
    const izq = c.startsWith(":");
    if (izq && der) return "center";
    if (der) return "right";
    return "left";
  });
}

function leerPortada(json: string): PortadaSpec | null {
  try {
    const d = JSON.parse(json) as Partial<PortadaSpec>;
    if (!d.title || typeof d.title !== "string") return null;
    return {
      title: d.title,
      subtitulo: typeof d.subtitulo === "string" ? d.subtitulo : undefined,
      metricas: Array.isArray(d.metricas)
        ? d.metricas
            .filter((m): m is MetricaPortada => !!m && !!m.value && !!m.etiqueta)
            .slice(0, 4)
        : undefined,
    };
  } catch {
    return null;
  }
}

export function parsearMarkdown(markdown: string): Bloque[] {
  const lineas = markdown.replace(/\r\n/g, "\n").split("\n");
  const bloques: Bloque[] = [];
  let parrafo: string[] = [];

  const cerrarParrafo = () => {
    const texto = parrafo.join(" ").trim();
    if (texto) bloques.push({ tipo: "parrafo", texto });
    parrafo = [];
  };

  for (let i = 0; i < lineas.length; i++) {
    const linea = lineas[i];
    const t = linea.trim();

    // Bloque cercado: ```portada { … }. Cualquier otro lenguaje se ignora
    // (no renderizamos código ni gráficas en el PDF).
    if (t.startsWith("```")) {
      const lenguaje = t.slice(3).trim().toLowerCase();
      const cuerpo: string[] = [];
      i++;
      while (i < lineas.length && !lineas[i].trim().startsWith("```")) {
        cuerpo.push(lineas[i]);
        i++;
      }
      cerrarParrafo();
      if (lenguaje === "portada" || lenguaje === "cover") {
        const spec = leerPortada(cuerpo.join("\n"));
        if (spec) bloques.push({ tipo: "portada", spec });
      }
      continue;
    }

    if (!t) {
      cerrarParrafo();
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) {
      cerrarParrafo();
      bloques.push({ tipo: "separador" });
      continue;
    }

    const title = /^(#{1,6})\s+(.*)$/.exec(t);
    if (title) {
      cerrarParrafo();
      const nivel = Math.min(title[1].length, 3) as 1 | 2 | 3;
      bloques.push({ tipo: "title", nivel, texto: title[2].trim() });
      continue;
    }

    // Tabla: fila de encabezado seguida de la línea separadora.
    if (t.includes("|") && i + 1 < lineas.length && esSeparadorTabla(lineas[i + 1])) {
      cerrarParrafo();
      const encabezados = celdas(t);
      const alineacion = alineacionesDe(lineas[i + 1]);
      const filas: string[][] = [];
      i += 2;
      while (i < lineas.length && lineas[i].includes("|") && lineas[i].trim()) {
        filas.push(celdas(lineas[i]));
        i++;
      }
      i--;
      bloques.push({
        tipo: "tabla",
        encabezados,
        filas,
        alineacion: encabezados.map((_, c) => alineacion[c] ?? "left"),
      });
      continue;
    }

    const vineta = /^[-*+]\s+(.*)$/.exec(t);
    const numerada = /^\d+[.)]\s+(.*)$/.exec(t);
    if (vineta || numerada) {
      cerrarParrafo();
      const ordenada = !!numerada;
      const items: string[] = [(vineta ?? numerada)![1].trim()];
      while (i + 1 < lineas.length) {
        const sig = lineas[i + 1].trim();
        const m = ordenada ? /^\d+[.)]\s+(.*)$/.exec(sig) : /^[-*+]\s+(.*)$/.exec(sig);
        if (!m) break;
        items.push(m[1].trim());
        i++;
      }
      bloques.push({ tipo: "lista", ordenada, items });
      continue;
    }

    parrafo.push(t);
  }
  cerrarParrafo();

  numerarSecciones(bloques);
  return bloques;
}

// Numera los títulos de nivel 2 (1., 2., 3.…) como en un informe impreso.
function numerarSecciones(bloques: Bloque[]): void {
  let n = 0;
  for (const b of bloques) {
    if (b.tipo === "title" && b.nivel === 2) {
      n++;
      b.numero = `${n}.`;
    }
  }
}

/** Quita el formato inline que el PDF no pinta (negritas, código, enlaces). */
export function textoPlano(texto: string): string {
  return texto
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}

/** ¿La celda lleva negrita? Se usa para resaltar totales en las tablas. */
export function esResaltada(celda: string): boolean {
  return /^\*\*.+\*\*$/.test(celda.trim());
}
