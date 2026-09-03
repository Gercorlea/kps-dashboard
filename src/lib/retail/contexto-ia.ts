// Lo que KPS AI SABE del módulo Retail antes de consultar nada.
//
// Es el equivalente de CONTEXTO_SAP para Mongo: un bloque estático del prompt
// con las colecciones, sus campos en lenguaje de negocio, cómo están guardados
// los datos (que cambia las respuestas) y recetas de consulta. Se genera del
// mismo catálogo que usa la tool (consultas-ia.ts), así que no puede
// desincronizarse de lo que realmente se puede consultar.
//
// Es ESTÁTICO a propósito: entra en el prefijo cacheado del prompt, así que
// nada que cambie entre peticiones (conteos, fechas de la base) puede vivir
// aquí. Qué reportes hay cargados se pregunta con la tool (reportImports).
import { RETAILERS } from "@/lib/retail/retailers";
import { AGRUPAR_POR_MES, catalogoRetail, type EntradaCatalogo } from "./consultas-ia";

// Las retiradas van sin campos: están vacías y listar treinta nombres por
// colección sólo gasta prefijo cacheado y distrae de las vigentes.
function bloqueColeccion(e: EntradaCatalogo): string {
  if (!e.vigente) return `- ${e.coleccion} — RETIRADA (normalmente vacía). ${e.descripcion}`;
  const campos = e.campos.map((c) => `${c.campo} = ${c.etiqueta} (${c.tipo})`).join("; ");
  return `- ${e.coleccion} — VIGENTE. ${e.descripcion}\n  Campos: ${campos}.`;
}

const catalogo = catalogoRetail();
const vigentes = catalogo.filter((e) => e.vigente);
const retiradas = catalogo.filter((e) => !e.vigente);

const retailers = RETAILERS.map((r) => `${r.id} = ${r.nombre}`).join("; ");

export const CONTEXTO_RETAIL = `## Referencia interna: módulo Retail (MongoDB)

CONOCIMIENTO INTERNO, NO TEMA DE CONVERSACIÓN. Esto existe para que sepas
qué datos de Retail hay y cómo pedirlos con consultar_retail. Al usuario le
hablas de retailers, productos, marcas, unidades y ventas; nunca de
colecciones ni campos.

### Retailers (valores del campo account)
${retailers}.
Cuáles tienen reportes cargados, cuántos y qué periodo cubren cambia con
cada carga: se consulta siempre (salesReports agruparPor account, ver
recetas) y se responde con el dato, sin comentar el proceso. Un retailer
sin registros simplemente no tiene reportes cargados todavía: dilo así, no
digas que "no existe".

### Colecciones vigentes
${vigentes.map(bloqueColeccion).join("\n")}

### Colecciones retiradas
Existen por compatibilidad y no reciben datos. No las uses para responder
sobre ventas actuales ni concluyas "no hay datos" por consultarlas.
${retiradas.map(bloqueColeccion).join("\n")}

### Cómo están guardados los datos de salesReports (cambia las respuestas)
- Un registro por artículo × día × retailer; la clave es (account, itemNbr,
  date). Volver a subir un reporte ACTUALIZA los registros, no los duplica.
- posQty son las unidades vendidas y posSales el importe de ventas netas.
  Toda cifra de ventas sale de sumar esos dos campos con agruparPor/sumar.
- El precio promedio de un producto o de un periodo es posSales / posQty
  calculado sobre los totales. Nunca promedies avgPrice fila a fila.
- itemQtySold duplica a posQty: no lo sumes además. basketOccurrences es una
  medida de canasta, no son ventas. avgSalesPerStore es un promedio simple
  y el número de tiendas NO está en los datos: no lo inventes.
- date es la fecha calendario (medianoche UTC). wmMonth es el mes FISCAL de
  Walmart ("2026/05") y puede no coincidir con el mes calendario. "Ventas de
  mayo" se responde con date salvo que el usuario hable de mes fiscal; si la
  diferencia importa, acláralo en una frase.
- sourceFiles lista los archivos de reporte que contienen la fila. Dos
  reportes que se solapan comparten filas: nunca sumes archivo por archivo
  para un total del retailer, porque contarías dos veces.
- Las fechas en filtros van como AAAA-MM-DD. Para un mes completo usa
  mayorQue con el último día del mes anterior y menorQue con el primer día
  del mes siguiente (marzo 2026: mayorQue 2026-02-28 y menorQue 2026-04-01).
- Si consultar_retail devuelve camposIgnorados, ese filtro no aplicó a esa
  colección: corrige la consulta antes de responder.

### Recetas de consulta (consultar_retail)
- Qué retailers tienen datos, cuántas unidades y qué periodo cubren (una
  sola llamada): coleccion salesReports, agruparPor account, sumar posQty.
  Cada fila trae registros, desde y hasta. Es lo primero que consultas
  cuando preguntan "qué información tienes de Retail".
- Ventas de un retailer en un periodo, por marca: coleccion salesReports;
  filtros account igual <retailer>, date mayorQue/menorQue; agruparPor
  brand; sumar posSales (y otra llamada con sumar posQty para unidades).
- Producto más vendido: igual, agruparPor itemDesc, sumar posQty.
- Ventas por mes de un retailer: agruparPor "${AGRUPAR_POR_MES}" (mes calendario
  AAAA-MM del campo de fecha) con sumar posSales; sale en orden cronológico.
- Toda agrupación devuelve además desde/hasta del campo de fecha del grupo:
  úsalo para decir qué periodo cubre cada cifra.
- Por mes fiscal de Walmart: agruparPor wmMonth.
- Qué reportes se han cargado y cuándo: coleccion reportImports, filtro
  account igual <retailer>, ordenarPor importedAt dir desc.
- Detalle de un producto (ver filas): salesReports con filtros itemDesc
  contiene <texto> o upc igual <upc>, ordenarPor date dir desc.
- Ventas facturadas en SAP por cliente o artículo: coleccion sapSales,
  agruparPor cardName o itemCode, sumar lineTotal o quantity, con filtros
  docDate. Es la copia completa de las facturas: cubre todo el histórico.
- Un ranking o un total se pide SIEMPRE agregado (agruparPor/sumar), nunca
  contando filas de una muestra.
- Crecimiento (productos, marcas, clientes, retailers): comparar_periodos_retail
  con metrica y periodo; devuelve actual, anterior, diferencia y % por grupo.
- Lotes más vendidos: coleccion sapSalesLotes, agruparPor batch, sumar
  quantity. Frescura de un lote: consultar_sap BatchNumberDetails (ver la
  referencia SAP), que ya trae los días calculados.
- Pronóstico / forecast / proyección: pronosticar_retail con coleccion
  salesReports, metrica posQty o posSales, horizonte en meses (o hastaMes
  para meses concretos) y, para "todos los datos", agruparPor account (una
  serie por retailer). Por marca de un retailer: filtro account igual
  <retailer> y agruparPor brand. Nunca una serie de salesReports sin
  account: mezclaría retailers con datos hasta meses distintos.`;
