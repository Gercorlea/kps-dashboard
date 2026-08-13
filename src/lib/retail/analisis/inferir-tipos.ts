// Inferencia de esquema sobre una hoja cruda: dónde está el encabezado, qué
// tipo tiene cada columna y cómo leer los números y fechas que vienen como
// texto.
//
// Módulo puro y sin imports de runtime: toda la lógica delicada del analizador
// vive aquí y se prueba sin DOM ni navegador (tests/excel-inferencia.test.ts).

import type {
  CeldaCruda,
  FilaCruda,
  FormatoNumerico,
  MetaColumna,
  TipoColumna,
} from "./tipos";

// Proporción de la muestra que debe calzar para fijar el tipo de una columna.
// 0.8 y no 1.0 para tolerar el "N/A" o el "-" suelto en una columna numérica.
const UMBRAL_TIPO = 0.8;

// Proporción necesaria para decidir que un separador solitario es de miles.
const UMBRAL_SEPARADOR = 0.9;

const MAX_FILAS_ENCABEZADO = 20;
const MUESTRA_CABECERA = 200;
const MUESTRA_TOTAL = 2000;
const MUESTRA_PASO = 1000;

const RE_ISO = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/;
const RE_DMY = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/;
// Tras quitar moneda y espacios, un valor numérico sólo tiene dígitos y separadores.
const RE_SOLO_NUMERO = /^\d[\d.,]*$/;

// -------------------------------------------------------------- utilidades

function estaVacia(v: CeldaCruda): boolean {
  return v === null || v === undefined || (typeof v === "string" && v.trim() === "");
}

function esFechaValida(v: unknown): v is Date {
  return v instanceof Date && !Number.isNaN(v.getTime());
}

/** 0 → "A", 25 → "Z", 26 → "AA" (nomenclatura de columnas de Excel). */
export function letraColumna(indice: number): string {
  let n = indice;
  let letra = "";
  do {
    letra = String.fromCharCode(65 + (n % 26)) + letra;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return letra;
}

/**
 * Primeras 200 filas más ~1000 con paso a lo largo del resto.
 * El paso importa: los exports suelen cambiar de forma al final (una fila
 * "TOTAL GENERAL") y tomar sólo las primeras 1000 las clasifica mal.
 */
function muestrear(filas: FilaCruda[]): FilaCruda[] {
  const n = filas.length;
  if (n <= MUESTRA_TOTAL) return filas;
  const salida = filas.slice(0, MUESTRA_CABECERA);
  const paso = Math.max(1, Math.floor((n - MUESTRA_CABECERA) / MUESTRA_PASO));
  for (let i = MUESTRA_CABECERA; i < n; i += paso) salida.push(filas[i]);
  return salida;
}

// ------------------------------------------------------ números localizados

/**
 * Decide, para una columna completa, cómo interpretar un separador solitario.
 * Se resuelve por columna y nunca por celda: adivinar celda a celda deja una
 * columna donde algunas filas quedan 1000x desviadas, que es la causa más
 * probable de un total mal calculado.
 */
export function detectarFormatoNumerico(valores: string[]): FormatoNumerico {
  let puntoDecimal = 0;
  let comaDecimal = 0;
  let conComa = 0;
  let comaMiles = 0;
  let conPunto = 0;
  let puntoMiles = 0;

  for (const bruto of valores) {
    const t = limpiarNumero(bruto);
    if (t === null) continue;

    const ultPunto = t.lastIndexOf(".");
    const ultComa = t.lastIndexOf(",");

    if (ultPunto >= 0 && ultComa >= 0) {
      // Con ambos separadores presentes, el de más a la derecha es el decimal.
      if (ultPunto > ultComa) puntoDecimal++;
      else comaDecimal++;
      continue;
    }

    if (ultComa >= 0) {
      conComa++;
      // Repetido (1,234,567) o con exactamente 3 dígitos detrás: es de miles.
      if (t.indexOf(",") !== ultComa || t.length - ultComa - 1 === 3) comaMiles++;
    } else if (ultPunto >= 0) {
      conPunto++;
      if (t.indexOf(".") !== ultPunto || t.length - ultPunto - 1 === 3) puntoMiles++;
    }
  }

  if (puntoDecimal > 0 || comaDecimal > 0) {
    return puntoDecimal >= comaDecimal ? "coma-miles" : "punto-miles";
  }
  if (conComa > 0 && comaMiles / conComa >= UMBRAL_SEPARADOR) return "coma-miles";
  if (conPunto > 0 && puntoMiles / conPunto >= UMBRAL_SEPARADOR) return "punto-miles";
  // Sin evidencia: el separador solitario es decimal.
  return "nativo";
}

/**
 * Quita moneda, espacios y signo, y verifica que lo que queda sea realmente un
 * número. Devuelve null ante cualquier carácter ajeno: "Cliente 3" no es 3.
 */
function limpiarNumero(texto: string): string | null {
  let t = texto.trim();
  if (t === "") return null;
  if (t.startsWith("(") && t.endsWith(")")) t = t.slice(1, -1).trim();
  t = t.replace(/[$€£¥\s ]/g, "");
  if (t.startsWith("-") || t.startsWith("+")) t = t.slice(1);
  return RE_SOLO_NUMERO.test(t) ? t : null;
}

export function parsearNumeroLocalizado(
  texto: string,
  formato: FormatoNumerico
): number | null {
  const bruto = texto.trim();
  if (bruto === "") return null;

  // Paréntesis o signo delante: convención contable para negativos.
  let negativo = bruto.startsWith("(") && bruto.endsWith(")");
  if (bruto.replace(/[($€£¥\s ]/g, "").startsWith("-")) negativo = true;

  let t = limpiarNumero(bruto);
  if (t === null) return null;

  const ultPunto = t.lastIndexOf(".");
  const ultComa = t.lastIndexOf(",");

  if (ultPunto >= 0 && ultComa >= 0) {
    if (ultPunto > ultComa) t = t.replace(/,/g, "");
    else t = t.replace(/\./g, "").replace(",", ".");
  } else if (ultComa >= 0) {
    t = formato === "coma-miles" ? t.replace(/,/g, "") : t.replace(",", ".");
  } else if (ultPunto >= 0 && formato === "punto-miles") {
    t = t.replace(/\./g, "");
  }

  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  return negativo ? -n : n;
}

// ------------------------------------------------------- fechas como texto

/**
 * dd/mm vs mm/dd se resuelve mirando la columna entera, nunca fila por fila:
 * un componente mayor que 12 delata cuál es el día.
 */
export function detectarOrdenFecha(valores: string[]): "dia-mes" | "mes-dia" {
  let diaMes = 0;
  let mesDia = 0;
  for (const v of valores) {
    const m = RE_DMY.exec(v.trim());
    if (!m) continue;
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a > 12) diaMes++;
    else if (b > 12) mesDia++;
  }
  // Sin evidencia, dd/mm: convención es-MX y la del resto del módulo (trampa 2).
  return mesDia > diaMes ? "mes-dia" : "dia-mes";
}

/**
 * Siempre `new Date(y, m - 1, d)`, jamás `new Date("2024-01-05")`: la forma
 * string se interpreta como medianoche UTC y en un huso negativo (México es
 * UTC-6) corre cada fecha un día, moviendo las ventas de fin de mes al mes
 * equivocado. Todo el analizador lee fechas con getters LOCALES.
 */
function construirFecha(anio: number, mes: number, dia: number): Date | null {
  let a = anio;
  if (a < 100) a = a < 70 ? 2000 + a : 1900 + a;
  if (mes < 1 || mes > 12 || dia < 1 || dia > 31) return null;
  const d = new Date(a, mes - 1, dia);
  // Rechaza fechas imposibles como 31/02, que JS normalizaría en silencio.
  if (d.getFullYear() !== a || d.getMonth() !== mes - 1 || d.getDate() !== dia) return null;
  return d;
}

export function parsearFechaTexto(
  texto: string,
  orden: "dia-mes" | "mes-dia"
): Date | null {
  const t = texto.trim();
  if (t === "") return null;

  const iso = RE_ISO.exec(t);
  if (iso) return construirFecha(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const dmy = RE_DMY.exec(t);
  if (!dmy) return null;
  const a = Number(dmy[1]);
  const b = Number(dmy[2]);
  const anio = Number(dmy[3]);
  return orden === "dia-mes" ? construirFecha(anio, b, a) : construirFecha(anio, a, b);
}

// ------------------------------------------------------------- encabezado

/**
 * Los exports suelen traer título y rango de fechas antes del encabezado real
 * (trampa 1 del parser de ingesta). Devuelve el índice 0-based de la fila de
 * encabezado, o -1 si no hay ninguna (entonces los datos empiezan en la fila 0
 * y los nombres se sintetizan).
 */
export function detectarEncabezado(datos: FilaCruda[]): number {
  const limite = Math.min(datos.length, MAX_FILAS_ENCABEZADO);
  let ancho = 0;
  for (let i = 0; i < limite; i++) ancho = Math.max(ancho, datos[i].length);
  if (ancho === 0) return -1;

  let respaldo = -1;

  for (let i = 0; i < limite; i++) {
    const fila = datos[i];
    let noVacias = 0;
    let textos = 0;
    for (const celda of fila) {
      if (estaVacia(celda)) continue;
      noVacias++;
      if (typeof celda === "string") textos++;
    }
    if (noVacias === 0) continue;
    // Un encabezado no es una fila con dos celdas sueltas: eso es un título.
    if (noVacias / ancho < 0.6) continue;
    if (textos / noVacias < UMBRAL_TIPO) continue;

    if (respaldo === -1) respaldo = i;

    // Un encabezado es texto y lo que va debajo normalmente no lo es.
    const siguiente = datos[i + 1];
    if (!siguiente) continue;
    for (const celda of siguiente) {
      if (!estaVacia(celda) && typeof celda !== "string") return i;
    }
  }

  // Archivo enteramente de texto: la primera fila que parece encabezado lo es.
  return respaldo;
}

// -------------------------------------------------------------- columnas

function nombresDeColumnas(fila: FilaCruda | null, ancho: number): string[] {
  const vistos = new Map<string, number>();
  const nombres: string[] = [];

  for (let i = 0; i < ancho; i++) {
    const bruto = fila?.[i];
    let nombre =
      bruto === null || bruto === undefined
        ? ""
        : String(bruto instanceof Date ? bruto.toISOString() : bruto)
            .trim()
            .replace(/\s+/g, " ");
    if (nombre === "") nombre = `Columna ${letraColumna(i)}`;

    // Dos columnas "Total" deben poder seleccionarse por separado.
    const previas = vistos.get(nombre) ?? 0;
    vistos.set(nombre, previas + 1);
    nombres.push(previas === 0 ? nombre : `${nombre} (${previas + 1})`);
  }

  return nombres;
}

export function construirColumnas(
  filasDatos: FilaCruda[],
  filaEncabezado: FilaCruda | null,
  ancho: number
): MetaColumna[] {
  const nombres = nombresDeColumnas(filaEncabezado, ancho);
  const muestra = muestrear(filasDatos);
  const columnas: MetaColumna[] = [];

  for (let c = 0; c < ancho; c++) {
    const textos: string[] = [];
    let noVacias = 0;
    let fechasNativas = 0;

    for (const fila of muestra) {
      const v = fila[c];
      if (estaVacia(v)) continue;
      noVacias++;
      if (esFechaValida(v)) fechasNativas++;
      else if (typeof v === "string") textos.push(v);
    }

    // El formato debe conocerse antes de clasificar: de él depende si "1.234"
    // cuenta como número.
    const formatoNumerico = detectarFormatoNumerico(textos);
    const ordenFecha = detectarOrdenFecha(textos);

    let numeros = 0;
    let fechas = fechasNativas;
    let magnitud = 0;
    let todosEnteros = true;
    const distintos = new Set<string>();

    for (const fila of muestra) {
      const v = fila[c];
      if (estaVacia(v)) continue;
      distintos.add(esFechaValida(v) ? String(v.getTime()) : String(v));

      let n: number | null = null;
      if (typeof v === "number") n = v;
      else if (typeof v === "string") {
        const comoFecha = parsearFechaTexto(v, ordenFecha);
        if (comoFecha) {
          fechas++;
          continue;
        }
        n = parsearNumeroLocalizado(v, formatoNumerico);
      }

      if (n !== null && Number.isFinite(n)) {
        numeros++;
        magnitud += Math.abs(n);
        if (!Number.isInteger(n)) todosEnteros = false;
      }
    }

    let tipo: TipoColumna;
    if (noVacias === 0) tipo = "vacia";
    else if (fechas / noVacias >= UMBRAL_TIPO) tipo = "fecha";
    else if (numeros / noVacias >= UMBRAL_TIPO) tipo = "numero";
    // Lo mixto cae a categoría: siempre se puede graficar, mientras que un
    // "numero" mal clasificado produce sumas silenciosamente incorrectas.
    else tipo = "categoria";

    const cardinalidad = distintos.size;

    columnas.push({
      indice: c,
      nombre: nombres[c],
      tipo,
      noVacias,
      cardinalidad,
      esIdentificador:
        tipo === "numero" && todosEnteros && noVacias > 0 && cardinalidad / noVacias > 0.9,
      magnitud: tipo === "numero" ? magnitud : 0,
      formatoNumerico,
      ordenFecha: tipo === "fecha" ? ordenFecha : null,
    });
  }

  return columnas;
}

// ------------------------------------------------------------- accesores

/** Valor numérico de una celda según el formato ya decidido para su columna. */
export function valorNumerico(v: CeldaCruda, col: MetaColumna): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") return parsearNumeroLocalizado(v, col.formatoNumerico);
  // Un número suelto NUNCA se interpreta como serial de Excel: el heurístico
  // "entre 25569 y 60000 seguro es una fecha" convierte importes en fechas.
  // SheetJS con cellDates ya devuelve Date cuando la celda tiene formato de
  // fecha, así que no hay nada que adivinar.
  return null;
}

export function valorFecha(v: CeldaCruda, col: MetaColumna): Date | null {
  if (esFechaValida(v)) return v;
  if (typeof v === "string") return parsearFechaTexto(v, col.ordenFecha ?? "dia-mes");
  return null;
}

// --------------------------------------------------------------- defaults

const RE_METRICA = /importe|total|venta|monto|valor|neto|bruto|precio|subtotal|ingreso|unidades|units/i;
const RE_DIMENSION =
  /cliente|producto|art[ií]culo|vendedor|categor[ií]a|sucursal|zona|regi[oó]n|canal|familia|marca|tienda|almac[eé]n|sku|brand|store/i;

/** Cardinalidad máxima para que una columna produzca una barra legible. */
export const MAX_CARDINALIDAD_DIMENSION = 50;

/** Columnas ofrecidas como dimensión: categorías, más numéricas de baja cardinalidad. */
export function columnasDimension(columnas: MetaColumna[]): MetaColumna[] {
  return columnas.filter(
    (c) =>
      c.tipo === "categoria" ||
      ((c.tipo === "numero" || c.tipo === "fecha") &&
        c.cardinalidad > 1 &&
        c.cardinalidad <= MAX_CARDINALIDAD_DIMENSION)
  );
}

export function columnasMetrica(columnas: MetaColumna[]): MetaColumna[] {
  return columnas.filter((c) => c.tipo === "numero");
}

export function elegirMetrica(columnas: MetaColumna[]): number {
  const numericas = columnasMetrica(columnas);
  const porNombre = numericas.find((c) => RE_METRICA.test(c.nombre));
  if (porNombre) return porNombre.indice;

  // Excluir identificadores: si no, una columna de folios de 15k filas gana
  // por pura magnitud.
  const candidatas = numericas.filter((c) => !c.esIdentificador);
  if (candidatas.length === 0) return -1; // METRICA_CONTEO
  return candidatas.reduce((a, b) => (b.magnitud > a.magnitud ? b : a)).indice;
}

export function elegirDimension(columnas: MetaColumna[]): number {
  const candidatas = columnasDimension(columnas);
  if (candidatas.length === 0) return -1;

  const porNombre = candidatas.find(
    (c) => c.tipo === "categoria" && RE_DIMENSION.test(c.nombre)
  );
  if (porNombre) return porNombre.indice;

  const legibles = candidatas.filter(
    (c) => c.cardinalidad > 1 && c.cardinalidad <= MAX_CARDINALIDAD_DIMENSION
  );
  if (legibles.length > 0) {
    return legibles.reduce((a, b) => (b.cardinalidad < a.cardinalidad ? b : a)).indice;
  }
  return candidatas[0].indice;
}

export function elegirFecha(columnas: MetaColumna[]): number {
  return columnas.find((c) => c.tipo === "fecha")?.indice ?? -1;
}
