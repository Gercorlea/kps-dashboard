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

// El reporte mensual de Walmart Retail Link trae 26 filas de preámbulo
// (título, Report Options, Selections Include, la leyenda de Item Flags…), así
// que 20 no alcanzaba y el encabezado real quedaba sin detectar.
const MAX_FILAS_ENCABEZADO = 60;
const MUESTRA_CABECERA = 200;
const MUESTRA_TOTAL = 2000;
const MUESTRA_PASO = 1000;

const RE_ISO = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/;
// Año primero con cualquier separador: Walmart exporta "2024/07/06".
const RE_YMD = /^(\d{4})[/.](\d{1,2})[/.](\d{1,2})$/;
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
  // Un cero a la izquierda delata un CÓDIGO, no una cantidad: el UPC
  // "0750229353070" y el proveedor "063617" perderían el cero al pasar por
  // Number() y se mostrarían con separadores de miles. Se dejan como texto.
  if (/^0\d/.test(t)) return null;
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

  const iso = RE_ISO.exec(t) ?? RE_YMD.exec(t);
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

    // Un ID se delata de dos formas: por su nombre, o porque casi cada fila
    // trae un valor distinto. La segunda por sí sola no basta — "Item Nbr"
    // tiene 38 valores repartidos en 15 mil filas, así que la razón
    // cardinalidad/filas es diminuta y aun así es un identificador.
    const esIdentificador =
      tipo === "numero" &&
      todosEnteros &&
      noVacias > 0 &&
      (RE_CODIGO.test(nombres[c]) || cardinalidad / noVacias > 0.9);

    columnas.push({
      indice: c,
      nombre: nombres[c],
      tipo,
      noVacias,
      cardinalidad,
      esIdentificador,
      esConstante: noVacias > 0 && cardinalidad <= 1,
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

// Los reportes llegan con encabezados en español o en inglés (Walmart Retail
// Link exporta en inglés), así que los patrones cubren ambos.
//
// Dos niveles, y el orden importa: en un reporte de ventas la métrica que
// interesa por omisión es el DINERO, no la cantidad. Con un solo patrón
// "POS Qty" (columna 9) ganaría a "POS Sales" (columna 10) por ir antes.
const RE_METRICA_DINERO =
  /importe|venta|sales|monto|revenue|total|amount|ingreso|neto|bruto|subtotal/i;
const RE_METRICA_CANTIDAD =
  /qty|quantity|cantidad|unidades|units|precio|price|margin|margen|basket|canasta/i;

// Nombres que delatan un identificador y no una magnitud. Los límites de
// palabra evitan que "Numero de unidades" caiga aquí por el "num".
const RE_CODIGO = /\b(nbr|num|no|id|code|codigo|c[oó]digo|upc|ean|sku|folio|clave|barcode)\b/i;

const RE_DIMENSION =
  /cliente|producto|art[ií]culo|vendedor|categor[ií]a|sucursal|zona|regi[oó]n|canal|familia|marca|tienda|almac[eé]n|brand|store|desc/i;

/** Cardinalidad máxima para que una columna produzca una barra legible. */
export const MAX_CARDINALIDAD_DIMENSION = 50;

/**
 * ¿Sirve para agrupar? Categorías, más numéricas y fechas de baja cardinalidad.
 * Las constantes quedan fuera — agrupar por una columna con un solo valor
 * produce una barra única que no dice nada.
 */
export function esDimensionable(c: MetaColumna): boolean {
  return (
    !c.esConstante &&
    (c.tipo === "categoria" ||
      ((c.tipo === "numero" || c.tipo === "fecha") &&
        c.cardinalidad > 1 &&
        c.cardinalidad <= MAX_CARDINALIDAD_DIMENSION))
  );
}

/**
 * ¿Sirve para medir? Fuera los identificadores (sumar folios no significa nada)
 * y las constantes (una columna de puros ceros como "Net Net Unit Margin%" no
 * grafica nada).
 */
export function esMetricable(c: MetaColumna): boolean {
  return c.tipo === "numero" && !c.esIdentificador && !c.esConstante;
}

/**
 * Columnas ofrecidas como dimensión cuando NO hay plantilla que lo declare.
 * Con plantilla manda `opcionesDeFiltro` (plantillas.ts): adivinar está bien
 * para un archivo cualquiera, pero para un reporte conocido el catálogo de
 * filtros es una decisión de negocio y no un heurístico.
 */
// Genéricas para conservar el tipo del elemento: quien pasa `ColumnaResuelta[]`
// recibe `ColumnaResuelta[]` y puede leer `campo` sin castear.
export function columnasDimension<T extends MetaColumna>(columnas: T[]): T[] {
  return columnas.filter(esDimensionable);
}

/** Columnas ofrecidas como métrica cuando no hay plantilla. */
export function columnasMetrica<T extends MetaColumna>(columnas: T[]): T[] {
  return columnas.filter(esMetricable);
}

export function elegirMetrica(columnas: MetaColumna[]): number {
  const candidatas = columnasMetrica(columnas);
  if (candidatas.length === 0) return -1; // METRICA_CONTEO

  const dinero = candidatas.find((c) => RE_METRICA_DINERO.test(c.nombre));
  if (dinero) return dinero.indice;

  const cantidad = candidatas.find((c) => RE_METRICA_CANTIDAD.test(c.nombre));
  if (cantidad) return cantidad.indice;

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

/**
 * Columnas donde busca el buscador de producto: las de texto (descripción,
 * marca) y los códigos (UPC, Item Nbr).
 *
 * Fuera las métricas y las fechas: para esas el usuario tiene los filtros y el
 * rango, y dejarlas dentro haría que buscar "10" trajera cualquier fila cuyo
 * importe contenga un 10. Las columnas que se buscan se listan en la UI, para
 * que no haya que adivinar por qué una fila calzó.
 */
export function columnasBuscables(columnas: MetaColumna[]): MetaColumna[] {
  return columnas.filter(
    (c) =>
      !c.esConstante &&
      c.tipo !== "vacia" &&
      c.tipo !== "fecha" &&
      (c.tipo === "categoria" || c.esIdentificador)
  );
}
