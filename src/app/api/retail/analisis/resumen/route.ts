import type { PipelineStage } from "mongoose";
import type { NextRequest } from "next/server";
import type { z } from "zod";
import { handleApiError, ok, parseQuery } from "@/lib/api";
import { requireModule } from "@/lib/auth/guards";
import { connectDB } from "@/lib/db";
import { memoRetail } from "@/lib/retail/cache";
import { granularidadPorRango, SIN_VALOR } from "@/lib/retail/analisis/agregar";
import type { GrupoAcumulado, GrupoProducto } from "@/lib/retail/analisis/agregar";
import { columnasMetrica } from "@/lib/retail/analisis/inferir-tipos";
import {
  opcionesDeFiltro,
  plantillaPorId,
  seleccionHistorico,
} from "@/lib/retail/analisis/plantillas";
import type { Granularidad } from "@/lib/retail/analisis/tipos";
import { resumenAnalisisQuerySchema } from "@/lib/validation/retail";
import { SalesReport } from "@/models/SalesReport";

// GET /api/retail/analisis/resumen — acumuladores del último reporte guardado.
//
// Esta ruta NO agrega para una selección concreta: devuelve, en una sola pasada
// por la colección, la suma de TODAS las métricas para TODAS las dimensiones.
// El navegador elige cuál mirar y pliega el top-N con los helpers de agregar.ts.
//
// Es a propósito, y las dos veces por medición:
//   · Bajar las filas y agregarlas en el navegador costaba 48 s (5.2 MB por un
//     enlace de ~110 KB/s).
//   · Agregar aquí para la métrica elegida costaba un viaje por cada cambio de
//     filtro, y se veía el KPI cambiar de etiqueta antes que de valor.
// El juego completo de acumuladores son ~50 KB y un solo viaje: la carga
// inicial queda igual y cambiar de filtro deja de tocar la red.
//
// La serie diaria (735 buckets, 205 KB) es 4× el resto junta, así que sale del
// bundle y se pide con `parte=serie&granularidad=dia` sólo si alguien la elige.

/** Formato de $dateToString por granularidad. Claves que ordenan como texto. */
const FORMATO: Record<Granularidad, string> = {
  dia: "%Y-%m-%d",
  mes: "%Y-%m",
  anio: "%Y",
};

/**
 * Acumuladores de una rama del $facet: cuántas filas y, por cada métrica, su
 * suma y cuántas filas la traían legible.
 *
 * `n_*` va aparte de `conteo` porque `agregar.ts` descarta la fila cuya métrica
 * no es un número; sin ese conteo por métrica el PROMEDIO dividiría entre todas
 * las filas y no entre las que aportaron.
 */
function acumuladores(metricas: string[]) {
  const acc: Record<string, unknown> = { conteo: { $sum: 1 } };
  for (const m of metricas) {
    acc[`s_${m}`] = { $sum: `$${m}` };
    acc[`n_${m}`] = { $sum: { $cond: [{ $isNumber: `$${m}` }, 1, 0] } };
  }
  return acc;
}

/**
 * Misma normalización que `claveDimension` en agregar.ts: nulo o vacío cae en
 * (sin valor) en vez de desaparecer, porque las filas de subtotal que traen los
 * exports suelen llegar con la dimensión en blanco y tienen que verse.
 */
function claveDimension(v: unknown): string {
  if (v === null || v === undefined) return SIN_VALOR;
  const s = String(v).trim();
  return s === "" ? SIN_VALOR : s;
}

type FilaGrupo = Record<string, unknown> & { _id: unknown; conteo: number };

/**
 * Documentos del $group → `GrupoAcumulado[]`, fusionando las claves que se
 * normalizan a lo mismo. Fusionar aquí y no en el cliente es lo que permite que
 * `dimensiones[dim].length` sea directamente el KPI de valores distintos.
 */
function aGrupos(docs: FilaGrupo[], metricas: string[]): GrupoAcumulado[] {
  const mapa = new Map<string, GrupoAcumulado>();
  for (const d of docs) {
    const clave = claveDimension(d._id);
    const suma = metricas.map((m) => (d[`s_${m}`] as number) ?? 0);
    const n = metricas.map((m) => (d[`n_${m}`] as number) ?? 0);
    const previo = mapa.get(clave);
    if (previo) {
      previo.conteo += d.conteo;
      for (let i = 0; i < metricas.length; i++) {
        previo.suma[i] += suma[i];
        previo.n[i] += n[i];
      }
    } else {
      mapa.set(clave, { clave, conteo: d.conteo, suma, n });
    }
  }
  return [...mapa.values()];
}

/**
 * Igual que `aGrupos` pero para la rama de clave COMPUESTA de productos: el
 * `_id` es un objeto y no un escalar, así que la clave de fusión es la tupla de
 * valores ya normalizados. Se fusiona por la misma razón que allá: dos filas
 * cuyo UPC sólo difiere en espacios son el mismo producto.
 */
function aProductos(
  docs: FilaGrupo[],
  claves: string[],
  metricas: string[]
): GrupoProducto[] {
  const mapa = new Map<string, GrupoProducto>();
  for (const d of docs) {
    const id = (d._id ?? {}) as Record<string, unknown>;
    const valores = claves.map((c) => claveDimension(id[c]));
    // \u0000 no aparece en un valor de Excel, así que no puede haber dos tuplas
    // distintas que produzcan la misma clave al unirlas.
    const clave = valores.join("\u0000");
    const suma = metricas.map((m) => (d[`s_${m}`] as number) ?? 0);
    const n = metricas.map((m) => (d[`n_${m}`] as number) ?? 0);
    const previo = mapa.get(clave);
    if (previo) {
      previo.conteo += d.conteo;
      for (let i = 0; i < metricas.length; i++) {
        previo.suma[i] += suma[i];
        previo.n[i] += n[i];
      }
    } else {
      mapa.set(clave, { valores, conteo: d.conteo, suma, n });
    }
  }
  return [...mapa.values()];
}

type QueryResumen = z.infer<typeof resumenAnalisisQuerySchema>;

/**
 * El cálculo, sin permisos ni envoltorio HTTP: es lo que se guarda en memoria.
 *
 * Sale de GET para que `memoRetail` pueda envolverlo. La comprobación de acceso
 * se queda FUERA a propósito —se hace por petición, contra la sesión de quien
 * pregunta— porque lo que se cachea es el agregado, no el derecho a verlo.
 */
async function calcularResumen(q: QueryResumen) {
  await connectDB();

  // Qué archivo se está viendo. El más reciente por importedAt cuando no se
  // pide uno, igual que la ruta de filas, para que las dos coincidan.
  //
  // Esta búsqueda NO mira `desde`/`hasta` a propósito: identifica el archivo y
  // su plantilla, no el periodo. Acotarla por fechas dejaría un trimestre sin
  // reportes sin plantilla, y con ella se va la pestaña entera en vez de
  // quedarse en un periodo vacío, que es lo que de verdad pasó.
  const ultimo = await SalesReport.findOne(
    q.sourceFile
      ? { sourceFile: q.sourceFile, ...(q.account ? { account: q.account } : {}) }
      : q.account
        ? { account: q.account }
        : {}
  )
    .sort(q.sourceFile ? { date: 1 } : { importedAt: -1 })
    .select({ sourceFile: 1, template: 1, account: 1, importedAt: 1 })
    .lean();

  const plantilla = ultimo ? plantillaPorId(ultimo.template) : null;
  if (!ultimo || !plantilla) {
    // `cuentas` sólo hace falta en el bundle: es lo que llena el selector de
    // retailer, y la petición de la serie no lo repinta.
    const cuentas =
      q.parte === "bundle" ? ((await SalesReport.distinct("account")) as string[]) : [];
    return { archivo: null, cuentas, seleccion: null };
  }

  const { columnas, idxDimension, idxMetrica, idxFecha } = seleccionHistorico(plantilla);
  const campoDe = (i: number) => (i >= 0 ? columnas[i].campo : null);
  const fecha = campoDe(idxFecha);
  // Qué agrupar sale de la MISMA función que llena el selector del cliente:
  // una dimensión ofrecida sin su rama de acumuladores deja la gráfica en
  // blanco al elegirla, y una rama que nadie puede elegir es una pasada por
  // la colección regalada. Nada que venga de la query entra a un $group.
  //
  // Las métricas van por su cuenta y a propósito: se suman TODAS las de la
  // plantilla aunque el selector ofrezca sólo dos, porque la pestaña de
  // productos de la ficha del retailer pinta una columna por métrica con
  // estos mismos acumuladores. Ofrecer de menos en el filtro no es razón para
  // calcular de menos.
  const metricas = columnasMetrica(columnas).map((c) => c.campo);
  const dimensiones = opcionesDeFiltro(columnas, "dimension").map((c) => c.campo);
  // El grano de la pestaña de productos. Sale de la plantilla y nunca de la
  // query, igual que las dimensiones: nada que escriba el cliente entra a un
  // $group. Los campos se filtran contra las columnas declaradas para que una
  // plantilla mal escrita no agrupe por un campo que no existe.
  const claveProducto =
    plantilla.producto?.claves.filter((campo) => columnas.some((c) => c.campo === campo)) ?? [];
  // El periodo pedido, si lo hay. `date` se guarda a medianoche UTC
  // (SalesReport.ts:36), así que un $lte con la fecha desnuda incluye ese día
  // completo.
  const filtroFecha: Record<string, Date> = {};
  if (q.desde) filtroFecha.$gte = new Date(`${q.desde}T00:00:00.000Z`);
  if (q.hasta) filtroFecha.$lte = new Date(`${q.hasta}T00:00:00.000Z`);

  // Con alcance de cuenta se agregan TODOS los reportes del retailer, que es
  // lo que mira su ficha; con alcance de archivo, sólo el que se está viendo
  // en /retail/analisis. El resto del pipeline no distingue.
  //
  // El rango se mete AQUÍ y en un solo sitio: `base` alimenta tanto la rama
  // `parte=serie` como el $facet, así que las dos lo respetan sin que ninguna
  // etapa de abajo tenga que saber que existe. El campo de fecha sale de la
  // plantilla y nunca de la query, igual que las dimensiones.
  const base = {
    ...(q.alcance === "cuenta"
      ? { account: ultimo.account }
      : { account: ultimo.account, sourceFile: ultimo.sourceFile }),
    ...(fecha && Object.keys(filtroFecha).length > 0 ? { [fecha]: filtroFecha } : {}),
  };
  const acc = acumuladores(metricas);

  // Sólo la serie, en la granularidad pedida. Es la petición diferida de
  // "Día": el bundle ya trae la mensual.
  if (q.parte === "serie") {
    const granularidad = q.granularidad ?? "mes";
    const docs = fecha
      ? await SalesReport.aggregate<FilaGrupo>([
          { $match: base },
          {
            $group: {
              _id: {
                $dateToString: {
                  format: FORMATO[granularidad],
                  date: `$${fecha}`,
                  timezone: "UTC",
                },
              },
              ...acc,
            },
          },
        ])
      : [];
    return { metricas, serie: { granularidad, grupos: aGrupos(docs, metricas) } };
  }

  // Una rama por dimensión más la serie mensual y los totales, todo en una
  // sola pasada por la colección y un solo viaje de ida y vuelta.
  const ramas: Record<string, PipelineStage.FacetPipelineStage[]> = {};
  for (const d of dimensiones) ramas[`d_${d}`] = [{ $group: { _id: `$${d}`, ...acc } }];
  if (claveProducto.length > 0) {
    ramas.producto = [
      {
        $group: {
          _id: Object.fromEntries(claveProducto.map((c) => [c, `$${c}`])),
          ...acc,
        },
      },
    ];
  }
  if (fecha) {
    ramas.serie = [
      {
        $group: {
          _id: { $dateToString: { format: FORMATO.mes, date: `$${fecha}`, timezone: "UTC" } },
          ...acc,
        },
      },
    ];
  }
  ramas.totales = [
    {
      $group: {
        _id: null,
        ...acc,
        ...(fecha ? { desde: { $min: `$${fecha}` }, hasta: { $max: `$${fecha}` } } : {}),
      },
    },
  ];

  const [[facetado], cuentas] = await Promise.all([
    SalesReport.aggregate<Record<string, FilaGrupo[]>>([{ $match: base }, { $facet: ramas }]),
    // Retailers que TIENEN reportes guardados. Se mandan para que el selector
    // ofrezca sólo esos: listar los cuatro llevaría a elegir uno vacío y
    // toparse con un "sin datos" que no explica nada.
    SalesReport.distinct("account") as Promise<string[]>,
  ]);

  const totalesDoc = facetado?.totales?.[0];
  const totales = aGrupos(totalesDoc ? [totalesDoc] : [], metricas)[0] ?? {
    clave: "",
    conteo: 0,
    suma: metricas.map(() => 0),
    n: metricas.map(() => 0),
  };
  const rango = totalesDoc as unknown as { desde?: Date; hasta?: Date } | undefined;
  const desde = rango?.desde ? new Date(rango.desde) : null;
  const hasta = rango?.hasta ? new Date(rango.hasta) : null;

  return {
    // Con alcance de cuenta, `sourceFile` e `importedAt` son los del ÚLTIMO
    // reporte (útiles para la cabecera del retailer) mientras que `total` y
    // todo lo agregado abarcan los reportes del retailer completos.
    archivo: {
      sourceFile: ultimo.sourceFile,
      template: ultimo.template,
      account: ultimo.account,
      importedAt: ultimo.importedAt?.toISOString() ?? null,
      total: totales.conteo,
    },
    cuentas,
    seleccion: {
      dimension: campoDe(idxDimension),
      metrica: campoDe(idxMetrica),
      fecha,
    },
    metricas,
    // La automática se calcula sobre el rango COMPLETO, que una página de la
    // tabla no conoce.
    granularidad: desde && hasta ? granularidadPorRango(desde, hasta) : "mes",
    dimensiones: Object.fromEntries(
      dimensiones.map((d) => [d, aGrupos(facetado?.[`d_${d}`] ?? [], metricas)])
    ),
    serie: { granularidad: "mes" as Granularidad, grupos: aGrupos(facetado?.serie ?? [], metricas) },
    // Una fila por producto para la pestaña homónima de la ficha. Va aparte
    // de `dimensiones` porque su clave es compuesta y porque no llena ningún
    // selector: no es una dimensión más, es el grano de una tabla.
    producto:
      claveProducto.length > 0
        ? {
            campos: claveProducto,
            grupos: aProductos(facetado?.producto ?? [], claveProducto, metricas),
          }
        : null,
    totales,
    rangoFechas:
      desde && hasta
        ? { desde: desde.toISOString().slice(0, 10), hasta: hasta.toISOString().slice(0, 10) }
        : null,
  };
}

export async function GET(request: NextRequest) {
  try {
    await requireModule("retail");
    const q = parseQuery(request.url, resumenAnalisisQuerySchema);
    // La clave es la query entera ya validada, no la URL: así dos peticiones
    // que sólo se distinguen en el orden de los parámetros —o en uno que el
    // esquema rellena por defecto— comparten la misma entrada.
    const clave = [
      "resumen",
      q.account ?? "",
      q.sourceFile ?? "",
      q.alcance,
      q.parte,
      q.granularidad ?? "",
      // Sin el periodo en la clave, pedir un trimestre devolvería el agregado
      // del histórico completo que dejó ahí la carga inicial.
      q.desde ?? "",
      q.hasta ?? "",
    ].join("|");
    return ok(await memoRetail(clave, () => calcularResumen(q)));
  } catch (e) {
    return handleApiError(e);
  }
}
