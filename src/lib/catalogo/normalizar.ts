// Normalización de las celdas del Excel del catálogo.
//
// Se apoya en lib/retail/normalize.ts, que ya blinda las trampas comunes
// (encabezados con espacios, códigos que llegan como float, ausente ≠ 0,
// seriales de Excel). Aquí viven sólo las tres cosas que ese módulo no cubre:
// la clave de comparación de encabezados, la identidad del Item y el formato de
// fecha de este archivo en concreto.

import { parseCellDate, toCode, toText } from "@/lib/retail/normalize";

/**
 * Clave con la que se comparan encabezados y canales: sin acentos, en
 * minúsculas y con la puntuación colapsada a espacios.
 *
 * Vive aquí y no en columnas.ts porque la usan también canales.ts y el parser
 * de fechas, y es una normalización de texto, no un descriptor de columna.
 *
 * "  Fracción  Arancelaria " → "fraccion arancelaria"
 */
export function clave(h: unknown): string {
  return String(h ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[._/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * El Item es la clave del cruce entre las dos hojas del archivo: "ptal001 " y
 * "PTAL001" tienen que ser el mismo producto. Se aplica a Item y a sku, y
 * también al buscar un producto por su Item.
 *
 * Sin esto, un espacio de más en la hoja de mapeo dejaría al producto sin
 * ninguna venta y no habría nada visible que explicara por qué.
 */
export function normalizarItem(v: unknown): string {
  return toCode(v).trim().toUpperCase();
}

/**
 * El código del cliente como número, para cruzar con SalesReport.itemNbr.
 *
 * Sólo un ENTERO completo cruza: "1004.5", "A-1004" y "100436765 / 2" quedan en
 * null. Mejor una ficha sin ventas que una ficha con las ventas de otro
 * artículo, que además nadie detectaría.
 *
 * El tope de 15 dígitos evita perder precisión al pasar por Number (2^53).
 */
export function codigoNumerico(v: unknown): number | null {
  const s = toCode(v);
  if (!/^\d{1,15}$/.test(s)) return null;
  return Number(s);
}

const MESES: Record<string, number> = {
  ene: 1, enero: 1, jan: 1, january: 1,
  feb: 2, febrero: 2, february: 2,
  mar: 3, marzo: 3, march: 3,
  abr: 4, abril: 4, apr: 4, april: 4,
  may: 5, mayo: 5,
  jun: 6, junio: 6, june: 6,
  jul: 7, julio: 7, july: 7,
  ago: 8, agosto: 8, aug: 8, august: 8,
  sep: 9, sept: 9, septiembre: 9, september: 9,
  oct: 10, octubre: 10, october: 10,
  nov: 11, noviembre: 11, november: 11,
  dic: 12, diciembre: 12, dec: 12, december: 12,
};

/**
 * Fecha de lanzamiento: "1-Sep-24" → medianoche UTC del 2024-09-01.
 *
 * new Date("1-Sep-24") depende del motor y no entiende los meses en español,
 * así que se parsea a mano, igual que hace normalize.ts con "dd.mm.yyyy". Antes
 * se intentan los caminos que ese módulo ya resuelve: celda Date real (lo normal
 * cuando la columna tiene formato de fecha), serial de Excel, ISO y dd.mm.yyyy.
 *
 * Un año de dos dígitos se resuelve como 2000+yy. Es una CONVENCIÓN, no un
 * hecho: son fechas de lanzamiento de producto y no hay ninguna de los años 90
 * en el catálogo.
 *
 * Devuelve también el texto original cuando no se pudo interpretar, para que la
 * ficha muestre lo que traía el archivo en vez de un hueco: una fecha con
 * formato raro que desaparece es un dato perdido sin rastro.
 */
export function parseFechaCatalogo(v: unknown): { fecha: Date | null; texto: string } {
  const directa = parseCellDate(v);
  if (directa) return { fecha: directa, texto: "" };

  const texto = toText(v);
  if (!texto) return { fecha: null, texto: "" };

  const m = /^(\d{1,2})[-/ ]([A-Za-zÀ-ſ.]+)[-/ ](\d{2}|\d{4})$/.exec(texto);
  if (m) {
    const mes = MESES[clave(m[2]).replace(/\./g, "")];
    const anio = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    const dia = Number(m[1]);
    if (mes) {
      const d = new Date(Date.UTC(anio, mes - 1, dia));
      // Rechaza fechas imposibles (31-Feb haría rollover silencioso).
      if (d.getUTCDate() === dia && d.getUTCMonth() === mes - 1) {
        return { fecha: d, texto: "" };
      }
    }
  }

  return { fecha: null, texto };
}
