// Lector del Excel del catálogo: dos hojas, layout conocido.
//
// Corre en el NAVEGADOR. El .xlsx nunca sale del equipo de quien lo sube: de
// aquí salen filas ya normalizadas que viajan por lotes a la API, igual que en
// el analizador de /retail/analisis.
//
// Reutiliza `leerLibro` de retail/analisis/parsear.ts —que ya devuelve todas las
// hojas y valida extensión, firma ZIP, archivo vacío y protegido con
// contraseña—, pero NO `construirDataset`: ése infiere encabezado y tipos de un
// archivo desconocido, y aquí las columnas se declaran (ver columnas.ts).

import { ErrorExcel, leerLibro } from "@/lib/retail/analisis/parsear";
import type { FilaCruda, HojaCruda } from "@/lib/retail/analisis/tipos";
import { fechaISO, toCode, toNumber, toText } from "@/lib/retail/normalize";
import { resolverCanal } from "./canales";
import {
  COLUMNAS_MAPEO,
  COLUMNAS_PRODUCTO,
  puntuarEncabezado,
  resolverColumnas,
  tieneRequeridas,
  type ColumnaCatalogo,
  type Resolucion,
} from "./columnas";
import { MAX_FILAS_CATALOGO } from "@/lib/validation/catalogo";
import { clave, codigoNumerico, normalizarItem, parseFechaCatalogo } from "./normalizar";
import type { Incidencia } from "./tipos";

/** En cuántas filas se busca el encabezado antes de rendirse. */
const FILAS_BUSQUEDA_ENCABEZADO = 10;

/**
 * Cuántos encabezados conocidos tiene que traer una fila para aceptarla como
 * encabezado.
 *
 * Dos y no uno: con uno, una fila de datos que por casualidad trajera la
 * palabra "clave" se aceptaría como encabezado y el archivo se leería corrido.
 * Y no se exige que traiga TODAS las requeridas, porque entonces un archivo al
 * que sólo le falta la columna «Linea» fallaría con "no se encontró el
 * encabezado" en vez de con el motivo verdadero (ver leerProductos).
 */
const MIN_ACIERTOS_ENCABEZADO = 2;

const ALIAS_HOJA_PRODUCTOS = ["catalogo", "productos", "articulos", "items"];
const ALIAS_HOJA_MAPEO = ["mapeo", "clientes", "codigos", "canales", "sku"];

export interface ProductoLeido {
  item: string;
  description: string;
  status: string;
  line: string;
  ecom: string;
  trello: string;
  salesUnit: string;
  upc: string;
  satCode: string;
  tariffCode: string;
  suv: string;
  grammage: number | null;
  shelfLifeMonths: number | null;
  /** "YYYY-MM-DD" o null; el servidor la ancla a medianoche UTC. */
  launchDate: string | null;
  launchDateText: string;
  suppliers: string[];
  rowNumber: number;
}

export interface MapeoLeido {
  sku: string;
  channel: string;
  channelName: string;
  knownRetailer: boolean;
  customerCode: string;
  customerCodeNum: number | null;
  description: string;
  rowNumber: number;
}

export interface LecturaCatalogo {
  productSheet: string;
  mappingSheet: string | null;
  productos: ProductoLeido[];
  mapeos: MapeoLeido[];
  incidencias: Incidencia[];
  descartadas: { productos: number; mapeos: number };
}

function filaTieneAlgo(fila: FilaCruda | undefined): boolean {
  if (!fila) return false;
  return fila.some((v) => v !== null && v !== undefined && String(v).trim() !== "");
}

/**
 * Localiza las dos hojas.
 *
 * Por nombre primero, y si el nombre no dice nada, por POSICIÓN: la primera es
 * el catálogo y la segunda el mapeo, que es el orden del archivo. Después se
 * puntúan las dos candidatas por sus encabezados y se INTERCAMBIAN si están al
 * revés, para que reordenar o renombrar las hojas no rompa la carga.
 */
export function elegirHojas(hojas: HojaCruda[]): {
  productos: HojaCruda;
  mapeo: HojaCruda | null;
} {
  const porAlias = (alias: string[]) =>
    hojas.find((h) => {
      const c = clave(h.nombre);
      return alias.some((a) => c.includes(a));
    });

  let productos = porAlias(ALIAS_HOJA_PRODUCTOS) ?? hojas[0];
  let mapeo =
    hojas.find((h) => h !== productos && ALIAS_HOJA_MAPEO.some((a) => clave(h.nombre).includes(a))) ??
    hojas.find((h) => h !== productos) ??
    null;

  // El nombre es una pista; los encabezados son el discriminador de verdad.
  if (mapeo) {
    const encProductos = encabezadoProbable(productos, COLUMNAS_PRODUCTO);
    const encMapeo = encabezadoProbable(mapeo, COLUMNAS_MAPEO);
    const actual =
      puntuarEncabezado(encProductos, COLUMNAS_PRODUCTO) +
      puntuarEncabezado(encMapeo, COLUMNAS_MAPEO);
    const cruzado =
      puntuarEncabezado(encabezadoProbable(mapeo, COLUMNAS_PRODUCTO), COLUMNAS_PRODUCTO) +
      puntuarEncabezado(encabezadoProbable(productos, COLUMNAS_MAPEO), COLUMNAS_MAPEO);
    if (cruzado > actual) {
      const t = productos;
      productos = mapeo;
      mapeo = t;
    }
  }

  return { productos, mapeo };
}

/** La fila de las primeras 10 que más alias distintos calza, o [] si ninguna. */
function encabezadoProbable(hoja: HojaCruda, columnas: ColumnaCatalogo[]): FilaCruda {
  const i = indiceEncabezado(hoja, columnas);
  return i >= 0 ? hoja.datos[i] : [];
}

/**
 * Índice de la fila de encabezado, o -1.
 *
 * Se cuentan aciertos contra el vocabulario declarado en vez de usar la
 * heurística genérica de inferir-tipos.ts: aquí se sabe qué columnas se buscan,
 * y contar aciertos es estrictamente mejor que adivinar.
 *
 * Se prefiere la fila que trae TODAS las requeridas, y si ninguna las trae, la
 * que más aciertos suma. Esa segunda opción es la que permite dar el error útil
 * ("falta la columna «Línea»") en vez del genérico.
 */
function indiceEncabezado(hoja: HojaCruda, columnas: ColumnaCatalogo[]): number {
  const hasta = Math.min(FILAS_BUSQUEDA_ENCABEZADO, hoja.datos.length);
  let mejor = -1;
  let mejorPuntos = MIN_ACIERTOS_ENCABEZADO - 1;
  let completa = -1;
  let completaPuntos = MIN_ACIERTOS_ENCABEZADO - 1;

  for (let i = 0; i < hasta; i++) {
    const fila = hoja.datos[i];
    if (!filaTieneAlgo(fila)) continue;
    const puntos = puntuarEncabezado(fila, columnas);
    if (puntos > mejorPuntos) {
      mejorPuntos = puntos;
      mejor = i;
    }
    if (puntos > completaPuntos && tieneRequeridas(fila, columnas)) {
      completaPuntos = puntos;
      completa = i;
    }
  }

  return completa >= 0 ? completa : mejor;
}

/** Celda por índice, tolerando filas más cortas que el encabezado. */
function celda(fila: FilaCruda, i: number | undefined): unknown {
  if (i === undefined || i < 0) return null;
  return fila[i] ?? null;
}

/** Lee una celda según el tipo declarado de su columna. */
function leerCelda(fila: FilaCruda, col: ColumnaCatalogo, r: Resolucion): unknown {
  const i = r.indices.get(col.campo);
  const v = celda(fila, i);
  switch (col.tipo) {
    case "codigo":
      return toCode(v);
    case "numero":
      // Ausente ≠ 0: "", "ND" y "-" son null, nunca cero.
      return toNumber(v);
    case "fecha":
      return parseFechaCatalogo(v);
    case "lista": {
      const idx = r.grupos.get(col.campo) ?? (i === undefined ? [] : [i]);
      const vistos = new Set<string>();
      const salida: string[] = [];
      for (const j of idx) {
        const s = toText(celda(fila, j));
        if (!s || vistos.has(s.toLowerCase())) continue;
        vistos.add(s.toLowerCase());
        salida.push(s);
      }
      return salida;
    }
    default:
      return toText(v);
  }
}

/** Qué campos requeridos le faltan a una fila. */
function requeridosVacios(
  valores: Record<string, unknown>,
  columnas: ColumnaCatalogo[]
): ColumnaCatalogo[] {
  return columnas.filter((c) => c.requerida && !String(valores[c.campo] ?? "").trim());
}

/** Incidencias por las columnas que no se encontraron en la hoja. */
function incidenciasDeFaltantes(hoja: string, faltantes: ColumnaCatalogo[]): Incidencia[] {
  return faltantes.map((c) => ({
    sheet: hoja,
    field: c.campo,
    // Las que pinta la tabla son `aviso` y se ven en la cabecera: su ausencia
    // deja una columna en blanco y hay que poder explicarlo. El resto, `info`.
    severity: c.esperada ? ("aviso" as const) : ("info" as const),
    message: `No se encontró la columna «${c.etiqueta}»; ese dato quedará vacío.`,
  }));
}

function errorColumnasRequeridas(
  hoja: string,
  faltantes: ColumnaCatalogo[],
  encabezados: FilaCruda
): ErrorExcel {
  const nombres = faltantes.map((c) => `«${c.etiqueta}»`).join(", ");
  const vistos = encabezados
    .map((h) => toText(h))
    .filter(Boolean)
    .slice(0, 20)
    .join(", ");
  return new ErrorExcel(
    `En la hoja «${hoja}» falta ${faltantes.length === 1 ? "la columna" : "las columnas"} ${nombres}.`,
    `Sin ${faltantes.length === 1 ? "esa columna" : "esas columnas"} no se puede identificar cada producto. ` +
      `Los encabezados que sí se encontraron son: ${vistos || "ninguno"}. ` +
      "Revisa que el encabezado esté en las primeras filas de la hoja y vuelve a subirlo."
  );
}

/** Lee la hoja de catálogo. */
function leerProductos(hoja: HojaCruda): {
  productos: ProductoLeido[];
  incidencias: Incidencia[];
  descartadas: number;
} {
  const incidencias: Incidencia[] = [];

  const iEnc = indiceEncabezado(hoja, COLUMNAS_PRODUCTO);
  if (iEnc < 0) {
    throw new ErrorExcel(
      `No se encontró el encabezado en la hoja «${hoja.nombre}».`,
      "Se buscó en las primeras 10 filas una que trajera «Item», «Descripcion», «Estatus» y «Linea». " +
        "Si el encabezado está más abajo, quita las filas de arriba; si las columnas se llaman de otra forma, renómbralas."
    );
  }

  const encabezados = hoja.datos[iEnc];
  const r = resolverColumnas(encabezados, COLUMNAS_PRODUCTO);

  const requeridasFaltantes = r.faltantes.filter((c) => c.requerida);
  if (requeridasFaltantes.length > 0) {
    throw errorColumnasRequeridas(hoja.nombre, requeridasFaltantes, encabezados);
  }
  incidencias.push(...incidenciasDeFaltantes(hoja.nombre, r.faltantes));

  const productos: ProductoLeido[] = [];
  let descartadas = 0;

  for (let i = iEnc + 1; i < hoja.datos.length; i++) {
    const fila = hoja.datos[i];
    // Una fila totalmente vacía no aporta nada y no se reporta: son las filas
    // de relleno que Excel deja al final de cualquier hoja.
    if (!filaTieneAlgo(fila)) continue;
    const rowNumber = i + 1; // 1-based, como lo numera Excel

    const valores: Record<string, unknown> = {};
    for (const col of COLUMNAS_PRODUCTO) valores[col.campo] = leerCelda(fila, col, r);

    const item = normalizarItem(valores.item);
    const parcial = { ...valores, item };
    const vacios = requeridosVacios(parcial, COLUMNAS_PRODUCTO);
    if (vacios.length > 0) {
      descartadas++;
      incidencias.push({
        sheet: hoja.nombre,
        row: rowNumber,
        field: vacios[0].campo,
        severity: "aviso",
        message: `Fila ${rowNumber} descartada: viene sin ${vacios.map((c) => `«${c.etiqueta}»`).join(", ")}.`,
      });
      continue;
    }

    const fecha = valores.launchDate as { fecha: Date | null; texto: string };
    productos.push({
      item,
      description: String(valores.description ?? ""),
      status: String(valores.status ?? ""),
      line: String(valores.line ?? ""),
      ecom: String(valores.ecom ?? ""),
      trello: String(valores.trello ?? ""),
      salesUnit: String(valores.salesUnit ?? ""),
      upc: String(valores.upc ?? ""),
      satCode: String(valores.satCode ?? ""),
      tariffCode: String(valores.tariffCode ?? ""),
      suv: String(valores.suv ?? ""),
      grammage: (valores.grammage as number | null) ?? null,
      shelfLifeMonths: (valores.shelfLifeMonths as number | null) ?? null,
      launchDate: fecha?.fecha ? fechaISO(fecha.fecha) : null,
      launchDateText: fecha?.texto ?? "",
      suppliers: (valores.suppliers as string[] | undefined) ?? [],
      rowNumber,
    });
  }

  if (productos.length === 0) {
    throw new ErrorExcel(
      `La hoja «${hoja.nombre}» no trae ninguna fila de producto utilizable.`,
      descartadas > 0
        ? `Se leyeron ${descartadas} filas y todas venían sin Item, Descripcion, Estatus o Linea. Complétalas y vuelve a subir el archivo.`
        : "Debajo del encabezado no hay datos. Revisa que estés subiendo el archivo correcto."
    );
  }

  if (productos.length > MAX_FILAS_CATALOGO) {
    throw new ErrorExcel(
      `La hoja «${hoja.nombre}» trae ${productos.length.toLocaleString("es-MX")} productos.`,
      `El módulo admite hasta ${MAX_FILAS_CATALOGO.toLocaleString("es-MX")}. Un catálogo de ese tamaño no es el archivo esperado; revisa que no estés subiendo un reporte de ventas.`
    );
  }

  // Deduplicar por item, gana el último. Se hace aquí aunque el índice único de
  // Mongo ya lo garantice, porque dos filas con la misma clave repartidas en
  // dos de las órdenes paralelas del bulkWrite competirían entre sí (la misma
  // razón que `sinClavesRepetidas` en api/retail/analisis/route.ts).
  const porItem = new Map<string, ProductoLeido>();
  for (const p of productos) {
    const previa = porItem.get(p.item);
    if (previa) {
      incidencias.push({
        sheet: hoja.nombre,
        row: p.rowNumber,
        field: "item",
        severity: "aviso",
        message: `El Item «${p.item}» aparece en las filas ${previa.rowNumber} y ${p.rowNumber}; se conservó la de la fila ${p.rowNumber}.`,
      });
    }
    porItem.set(p.item, p);
  }

  return { productos: [...porItem.values()], incidencias, descartadas };
}

/** Lee la hoja de mapeo. Su ausencia no es un error. */
function leerMapeos(hoja: HojaCruda): {
  mapeos: MapeoLeido[];
  incidencias: Incidencia[];
  descartadas: number;
} {
  const incidencias: Incidencia[] = [];

  const iEnc = indiceEncabezado(hoja, COLUMNAS_MAPEO);
  if (iEnc < 0) {
    // A diferencia del catálogo, aquí no se rompe la carga: el mapeo es un
    // añadido y perderlo no deja el módulo inservible.
    return {
      mapeos: [],
      descartadas: 0,
      incidencias: [
        {
          sheet: hoja.nombre,
          severity: "aviso",
          message: `No se encontró el encabezado de la hoja «${hoja.nombre}» (se buscaba «sku» y «canal»); el catálogo se cargó sin mapeo.`,
        },
      ],
    };
  }

  const encabezados = hoja.datos[iEnc];
  const r = resolverColumnas(encabezados, COLUMNAS_MAPEO);
  incidencias.push(...incidenciasDeFaltantes(hoja.nombre, r.faltantes));

  const mapeos: MapeoLeido[] = [];
  let descartadas = 0;

  for (let i = iEnc + 1; i < hoja.datos.length; i++) {
    const fila = hoja.datos[i];
    if (!filaTieneAlgo(fila)) continue;
    const rowNumber = i + 1;

    const sku = normalizarItem(leerCelda(fila, COLUMNAS_MAPEO[0], r));
    const canalTexto = toText(celda(fila, r.indices.get("channel")));
    const canal = resolverCanal(canalTexto);
    const customerCode = toCode(celda(fila, r.indices.get("customerCode")));
    const description = toText(celda(fila, r.indices.get("description")));

    if (!sku || !canal.id) {
      descartadas++;
      incidencias.push({
        sheet: hoja.nombre,
        row: rowNumber,
        field: !sku ? "sku" : "channel",
        severity: "aviso",
        message: `Fila ${rowNumber} de mapeo descartada: viene sin ${!sku ? "«SKU»" : "«Canal»"}.`,
      });
      continue;
    }

    if (customerCode && codigoNumerico(customerCode) === null) {
      incidencias.push({
        sheet: hoja.nombre,
        row: rowNumber,
        field: "customerCode",
        severity: "info",
        message: `El código «${customerCode}» de ${canal.nombre} no es un número entero, así que no se puede cruzar con las ventas.`,
      });
    }

    mapeos.push({
      sku,
      channel: canal.id,
      channelName: canal.nombre,
      knownRetailer: canal.conocido,
      customerCode,
      customerCodeNum: codigoNumerico(customerCode),
      description,
      rowNumber,
    });
  }

  if (mapeos.length > MAX_FILAS_CATALOGO) {
    throw new ErrorExcel(
      `La hoja «${hoja.nombre}» trae ${mapeos.length.toLocaleString("es-MX")} filas de mapeo.`,
      `El módulo admite hasta ${MAX_FILAS_CATALOGO.toLocaleString("es-MX")}.`
    );
  }

  // Deduplicar por (sku, canal), gana el último. Mismo motivo que en productos.
  const porClave = new Map<string, MapeoLeido>();
  for (const m of mapeos) {
    const k = `${m.sku}|${m.channel}`;
    const previa = porClave.get(k);
    if (previa) {
      incidencias.push({
        sheet: hoja.nombre,
        row: m.rowNumber,
        severity: "info",
        message: `«${m.sku}» en ${m.channelName} aparece en las filas ${previa.rowNumber} y ${m.rowNumber}; se conservó la de la fila ${m.rowNumber}.`,
      });
    }
    porClave.set(k, m);
  }

  return { mapeos: [...porClave.values()], incidencias, descartadas };
}

/**
 * Lee el archivo completo: catálogo y mapeo.
 *
 * Sólo lanza (ErrorExcel) por el archivo en sí —no es .xlsx, está dañado o
 * protegido, no trae hojas, la hoja de catálogo no tiene encabezado, le faltan
 * columnas requeridas o no queda ninguna fila utilizable—. Todo lo demás sale
 * como incidencia y la carga continúa: el archivo lo mantiene una persona y
 * rechazarlo por una columna opcional la dejaría sin poder subir nada.
 */
export async function leerCatalogo(file: File): Promise<LecturaCatalogo> {
  const hojas = await leerLibro(file);
  const { productos: hojaProductos, mapeo: hojaMapeo } = elegirHojas(hojas);

  const p = leerProductos(hojaProductos);
  const m = hojaMapeo
    ? leerMapeos(hojaMapeo)
    : {
        mapeos: [],
        descartadas: 0,
        incidencias: [
          {
            sheet: "",
            severity: "aviso" as const,
            message:
              "El archivo trae una sola hoja, así que se cargó el catálogo sin mapeo de productos.",
          },
        ],
      };

  return {
    productSheet: hojaProductos.nombre,
    mappingSheet: hojaMapeo?.nombre ?? null,
    productos: p.productos,
    mapeos: m.mapeos,
    incidencias: [...p.incidencias, ...m.incidencias],
    descartadas: { productos: p.descartadas, mapeos: m.descartadas },
  };
}
