import { Document, Font, Page, StyleSheet, Text, View } from "@react-pdf/renderer";
import { esResaltada, parsearMarkdown, textoPlano, type Bloque } from "./markdown";

// Documento PDF de un reporte de KPS AI. Solo texto y tablas: sin gráficas.
// react-pdf no lee variables CSS, así que los colores del sistema CRONOS van
// literales. Helvetica viene integrada en el PDF: cero fuentes externas, cero
// riesgo de que el reporte falle por una descarga.
// Geometría de la página (LETTER 612pt menos 44pt de margen a cada lado) y
// medidas aproximadas de Helvetica. Con estos números calculamos anchos de
// columna en PUNTOS: los porcentajes proporcionales dejaban columnas más
// estrechas que su propio contenido, la fila se desbordaba y react-pdf
// terminaba escribiendo una posición corrupta que rompe el render entero.
const ANCHO_UTIL = 612 - 88;
const ALTO_UTIL = (792 - 46 - 52) * 0.94; // margen de seguridad en la estimación
const INTERLINEA = 12.75; // 8.5pt * 1.5
const ANCHO_CARACTER = 4.6; // ~8.5pt Helvetica
const PADDING_CELDA = 5;
const TROZO_PALABRA = 8; // una palabra sin espacios se parte en trozos de 8
const RE_TROZO = /.{1,8}/g;
const ANCHO_MINIMO = TROZO_PALABRA * ANCHO_CARACTER + PADDING_CELDA * 2;

// Sin esta partición, una palabra más ancha que su columna no se puede cortar
// y desborda la fila.
Font.registerHyphenationCallback((palabra) =>
  palabra.length > TROZO_PALABRA ? (palabra.match(RE_TROZO) ?? [palabra]) : [palabra]
);

const C = {
  tinta: "#15171c",
  tinta2: "#5a616c",
  tinta3: "#99a0ab",
  linea: "#e6e6e3",
  lineaSuave: "#f0f0ed",
  superficie: "#fafaf9",
  franja2: "#f0f0ed",
};

const s = StyleSheet.create({
  pagina: {
    paddingTop: 46,
    paddingBottom: 52,
    paddingHorizontal: 44,
    fontFamily: "Helvetica",
    fontSize: 9.5,
    color: C.tinta2,
    lineHeight: 1.5,
  },
  portada: { marginBottom: 26 },
  portadaMarca: { fontSize: 7.5, letterSpacing: 1.6, color: C.tinta3, marginBottom: 10 },
  portadaTitulo: {
    fontSize: 21,
    fontFamily: "Helvetica-Bold",
    color: C.tinta,
    lineHeight: 1.2,
    marginBottom: 6,
  },
  portadaSubtitulo: { fontSize: 10, color: C.tinta2, marginBottom: 16, lineHeight: 1.45 },
  metrics: { flexDirection: "row", paddingVertical: 12 },
  reglaPortada: { height: 1, backgroundColor: C.linea },
  metrica: { flex: 1, paddingRight: 12 },
  metricaValor: { fontSize: 15, fontFamily: "Helvetica-Bold", color: C.tinta },
  metricaUnidad: { fontSize: 8.5, fontFamily: "Helvetica", color: C.tinta3 },
  metricaEtiqueta: {
    fontSize: 6.8,
    letterSpacing: 0.7,
    color: C.tinta3,
    marginTop: 3,
    textTransform: "uppercase",
  },

  // Sin marginTop: un margen superior que no cabe en el salto de página hace
  // que react-pdf calcule una posición corrupta. El aire se pone abajo del
  // bloque anterior (tablas y párrafos ya llevan marginBottom).
  h1: { fontSize: 14, fontFamily: "Helvetica-Bold", color: C.tinta, marginBottom: 6 },
  h2: { fontSize: 11, fontFamily: "Helvetica-Bold", color: C.tinta, marginBottom: 6 },
  h3: { fontSize: 9.5, fontFamily: "Helvetica-Bold", color: C.tinta, marginBottom: 4 },
  parrafo: { marginBottom: 7 },
  // Línea dibujada con fondo, no con borde (ver nota en `celda`).
  separador: { height: 1, backgroundColor: C.lineaSuave, marginVertical: 12 },

  lista: { marginBottom: 7, paddingLeft: 2 },
  listaItem: { flexDirection: "row", marginBottom: 2.5 },
  listaVinneta: { width: 14, color: C.tinta3 },
  listaTexto: { flex: 1 },

  // El contenedor NO lleva borde: si una vista con borde se parte entre
  // páginas, react-pdf calcula mal el recorte y falla el render. Los bordes
  // van en las filas, que nunca se parten (wrap={false}).
  tabla: { marginBottom: 16 },
  grupoFilas: { marginBottom: 0 },
  filaEncabezado: { flexDirection: "row", backgroundColor: C.franja2 },
  row: { flexDirection: "row" },
  filaAlterna: { backgroundColor: C.superficie },
  celdaEncabezado: {
    paddingVertical: 5,
    paddingHorizontal: PADDING_CELDA,
    fontSize: 6.8,
    fontFamily: "Helvetica-Bold",
    letterSpacing: 0.5,
    color: C.tinta3,
    textTransform: "uppercase",
  },
  // Sin bordes: un borde que cae en el salto de página hace que react-pdf
  // calcule mal el recorte y falle el render completo. La separación de
  // filas se hace con franjas alternas, que no tienen ese problema.
  celda: {
    paddingVertical: 4.5,
    paddingHorizontal: PADDING_CELDA,
    fontSize: 8.5,
    color: C.tinta2,
  },
  celdaFuerte: { color: C.tinta, fontFamily: "Helvetica-Bold" },

  pie: {
    position: "absolute",
    bottom: 26,
    left: 44,
    right: 44,
    fontSize: 7,
    color: C.tinta3,
  },
  pieFila: { flexDirection: "row", justifyContent: "space-between", paddingTop: 6 },
});

function Portada({ bloque }: { bloque: Extract<Bloque, { tipo: "portada" }> }) {
  const { title, subtitle, metrics } = bloque.spec;
  return (
    <View style={s.portada}>
      <Text style={s.portadaMarca}>CRONOS RETAIL · KPS AI</Text>
      <Text style={s.portadaTitulo}>{title}</Text>
      {subtitle ? <Text style={s.portadaSubtitulo}>{subtitle}</Text> : null}
      {metrics?.length ? (
        <>
          <View style={s.reglaPortada} />
          <View style={s.metrics}>
          {metrics.map((m, i) => (
            <View key={i} style={s.metrica}>
              <Text>
                <Text style={s.metricaValor}>{m.value}</Text>
                {m.unit ? <Text style={s.metricaUnidad}> {m.unit}</Text> : null}
              </Text>
              <Text style={s.metricaEtiqueta}>{m.label}</Text>
            </View>
            ))}
          </View>
          <View style={s.reglaPortada} />
        </>
      ) : null}
    </View>
  );
}

function Filas({
  bloque,
  desde,
  hasta,
  ancho,
}: {
  bloque: Extract<Bloque, { tipo: "tabla" }>;
  desde: number;
  hasta: number;
  ancho: (i: number) => { width: number };
}) {
  const cols = bloque.encabezados.length;
  return (
    <View style={s.grupoFilas}>
      <View style={s.filaEncabezado}>
        {bloque.encabezados.map((h, i) => (
          <View key={i} style={ancho(i)}>
            <Text style={[s.celdaEncabezado, { textAlign: bloque.alineacion[i] }]}>
              {textoPlano(h)}
            </Text>
          </View>
        ))}
      </View>
      {bloque.filas.slice(desde, hasta).map((row, f) => (
        <View key={f} style={(desde + f) % 2 === 1 ? [s.row, s.filaAlterna] : s.row}>
          {Array.from({ length: cols }, (_, c) => {
            const bruta = row[c] ?? "";
            const fuerte = esResaltada(bruta) || c === 0;
            return (
              <View key={c} style={ancho(c)}>
                <Text
                  style={[s.celda, { textAlign: bloque.alineacion[c] }, fuerte ? s.celdaFuerte : {}]}
                >
                  {textoPlano(bruta)}
                </Text>
              </View>
            );
          })}
        </View>
      ))}
    </View>
  );
}

function Tabla({ bloque }: { bloque: Extract<Bloque, { tipo: "tabla" }> }) {
  const cols = bloque.encabezados.length;
  // Anchos en PUNTOS, no en porcentaje: cada columna arranca con un mínimo
  // que garantiza que cabe el trozo de palabra más ancho, y el espacio
  // sobrante se reparte según el contenido (con raíz, para que una columna
  // larga no se coma la tabla). El padding va DENTRO del Text: si va en el
  // mismo nodo que el ancho, se suma por fuera y desborda.
  const minimum = Math.min(ANCHO_MINIMO, ANCHO_UTIL / cols);
  const pesos = bloque.encabezados.map((h, i) =>
    Math.sqrt(
      Math.min(
        Math.max(textoPlano(h).length, ...bloque.filas.map((f) => textoPlano(f[i] ?? "").length), 3),
        60
      )
    )
  );
  const suma = pesos.reduce((a, b) => a + b, 0) || 1;
  const sobrante = Math.max(ANCHO_UTIL - minimum * cols, 0);
  const anchos = pesos.map((peso) => minimum + (peso / suma) * sobrante);
  const ancho = (i: number) => ({ width: anchos[i] ?? ANCHO_UTIL / cols });

  // El reparto en páginas ya troceó la tabla: aquí se pinta entera.
  return (
    <View style={s.tabla}>
      <Filas bloque={bloque} desde={0} hasta={bloque.filas.length} ancho={ancho} />
    </View>
  );
}

function BloqueVista({ bloque }: { bloque: Bloque }) {
  switch (bloque.tipo) {
    case "portada":
      return <Portada bloque={bloque} />;
    case "title": {
      const estilo = bloque.nivel === 1 ? s.h1 : bloque.nivel === 2 ? s.h2 : s.h3;
      const texto = bloque.numero ? `${bloque.numero}  ${bloque.texto}` : bloque.texto;
      // Sin wrap={false} ni minPresenceAhead: si el título cae justo en el
      // salto de página, react-pdf genera una coordenada corrupta y falla
      // el render entero. Que el título quede al final de una página es un
      // defecto estético; que no se genere el PDF no lo es.
      return (
        <Text style={estilo} orphans={1} widows={1}>
          {textoPlano(texto)}
        </Text>
      );
    }
    case "parrafo":
      return (
        <Text style={s.parrafo} orphans={1} widows={1}>
          {textoPlano(bloque.texto)}
        </Text>
      );
    case "tabla":
      return <Tabla bloque={bloque} />;
    case "lista":
      return (
        <View style={s.lista}>
          {bloque.items.map((it, i) => (
            <View key={i} style={s.listaItem}>
              <Text style={s.listaVinneta}>{bloque.ordenada ? `${i + 1}.` : "—"}</Text>
              <Text style={s.listaTexto}>{textoPlano(it)}</Text>
            </View>
          ))}
        </View>
      );
    case "separador":
      return <View style={s.separador} />;
  }
}

type Anchos = number[];

// Estimación de alturas. No hace falta que sea exacta: se aplica un margen
// del 6% al alto de página, y todo lo que se calcula de más solo deja aire.
function anchosDe(bloque: Extract<Bloque, { tipo: "tabla" }>): Anchos {
  const cols = bloque.encabezados.length;
  const minimum = Math.min(ANCHO_MINIMO, ANCHO_UTIL / cols);
  const pesos = bloque.encabezados.map((h, i) =>
    Math.sqrt(
      Math.min(
        Math.max(textoPlano(h).length, ...bloque.filas.map((f) => textoPlano(f[i] ?? "").length), 3),
        60
      )
    )
  );
  const suma = pesos.reduce((a, b) => a + b, 0) || 1;
  const sobrante = Math.max(ANCHO_UTIL - minimum * cols, 0);
  return pesos.map((peso) => minimum + (peso / suma) * sobrante);
}

function lineas(texto: string, ancho: number): number {
  const porLinea = Math.max(Math.floor(ancho / ANCHO_CARACTER), 1);
  return Math.max(Math.ceil(textoPlano(texto).length / porLinea), 1);
}

function altoFila(row: string[], anchos: Anchos): number {
  const max = Math.max(
    ...anchos.map((a, c) => lineas(row[c] ?? "", a - PADDING_CELDA * 2)),
    1
  );
  return max * INTERLINEA + 9;
}

const ALTO_ENCABEZADO = 21;

function altoBloque(b: Bloque): number {
  switch (b.tipo) {
    case "portada":
      return 60 + lineas(b.spec.title, ANCHO_UTIL) * 26 +
        (b.spec.subtitle ? lineas(b.spec.subtitle, ANCHO_UTIL) * 15 + 16 : 0) +
        (b.spec.metrics?.length ? 60 : 0);
    case "title":
      return (b.nivel === 1 ? 23 : b.nivel === 2 ? 19 : 16);
    case "parrafo":
      return lineas(b.texto, ANCHO_UTIL) * 14.25 + 7;
    case "lista":
      return b.items.reduce((t, i) => t + lineas(i, ANCHO_UTIL - 16) * 14.25 + 2.5, 7);
    case "separador":
      return 25;
    case "tabla": {
      const anchos = anchosDe(b);
      return ALTO_ENCABEZADO + b.filas.reduce((t, f) => t + altoFila(f, anchos), 0) + 16;
    }
  }
}

/**
 * Reparte los bloques en páginas. Lo hacemos nosotros en vez de dejar que
 * react-pdf pagine: su cálculo de cortes produce coordenadas corruptas con
 * documentos de varias secciones y tablas largas, y falla el render entero.
 * Aquí ningún elemento necesita partirse — las tablas se cortan por filas y
 * el encabezado se repite en cada trozo.
 */
function repartirEnPaginas(bloques: Bloque[]): Bloque[][] {
  const paginas: Bloque[][] = [];
  let actual: Bloque[] = [];
  let usado = 0;

  const nuevaPagina = () => {
    if (actual.length) paginas.push(actual);
    actual = [];
    usado = 0;
  };

  for (const bloque of bloques) {
    const alto = altoBloque(bloque);

    if (bloque.tipo === "tabla") {
      const anchos = anchosDe(bloque);
      let row = 0;
      while (row < bloque.filas.length) {
        let disponible = ALTO_UTIL - usado - ALTO_ENCABEZADO - 16;
        if (disponible < INTERLINEA * 3) {
          nuevaPagina();
          disponible = ALTO_UTIL - ALTO_ENCABEZADO - 16;
        }
        const trozo: string[][] = [];
        while (row < bloque.filas.length) {
          const h = altoFila(bloque.filas[row], anchos);
          if (trozo.length && h > disponible) break;
          trozo.push(bloque.filas[row]);
          disponible -= h;
          row++;
        }
        actual.push({ ...bloque, filas: trozo });
        usado = ALTO_UTIL - disponible;
      }
      continue;
    }

    // Un título al final de la página se lleva a la siguiente con su tabla.
    const reserva = bloque.tipo === "title" ? alto + INTERLINEA * 4 : alto;
    if (usado > 0 && usado + reserva > ALTO_UTIL) nuevaPagina();
    actual.push(bloque);
    usado += alto;
  }

  if (actual.length) paginas.push(actual);
  return paginas.length ? paginas : [[]];
}

export function ReportePdf({
  title,
  markdown,
  generadoEl,
}: {
  title: string;
  markdown: string;
  generadoEl: string;
}) {
  const bloques = parsearMarkdown(markdown);
  // Si el modelo no mandó portada, se arma una con el título del reporte.
  if (bloques[0]?.tipo !== "portada") {
    bloques.unshift({ tipo: "portada", spec: { title } });
  }
  const paginas = repartirEnPaginas(bloques);

  return (
    <Document title={title} author="Cronos Retail">
      {paginas.map((pagina, p) => (
        <Page key={p} size="LETTER" style={s.pagina}>
          {pagina.map((b, i) => (
            <BloqueVista key={i} bloque={b} />
          ))}
          <View style={s.pie} fixed>
            <View style={s.reglaPortada} />
            <View style={s.pieFila}>
              <Text>{title}</Text>
              <Text>
                {p + 1} / {paginas.length}
              </Text>
              <Text>{generadoEl}</Text>
            </View>
          </View>
        </Page>
      ))}
    </Document>
  );
}
