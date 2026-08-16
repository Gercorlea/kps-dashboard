import type { PipelineStage } from "mongoose";
import type { NextRequest } from "next/server";
import { handleApiError, ok, parseQuery } from "@/lib/api";
import { requireModule } from "@/lib/auth/guards";
import { connectDB } from "@/lib/db";
import { granularidadPorRango, SIN_VALOR } from "@/lib/retail/analisis/agregar";
import type { GrupoAcumulado } from "@/lib/retail/analisis/agregar";
import { columnasDimension, columnasMetrica } from "@/lib/retail/analisis/inferir-tipos";
import { plantillaPorId, seleccionHistorico } from "@/lib/retail/analisis/plantillas";
import type { ColumnaResuelta } from "@/lib/retail/analisis/plantillas";
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

export async function GET(request: NextRequest) {
  try {
    await requireModule("retail");
    const q = parseQuery(request.url, resumenAnalisisQuerySchema);
    await connectDB();

    // Qué archivo se está viendo. El más reciente por importedAt cuando no se
    // pide uno, igual que la ruta de filas, para que las dos coincidan.
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
      return ok({ archivo: null, cuentas, seleccion: null });
    }

    const { columnas, idxDimension, idxMetrica, idxFecha } = seleccionHistorico(plantilla);
    const campoDe = (i: number) => (i >= 0 ? columnas[i].campo : null);
    const fecha = campoDe(idxFecha);
    // Qué agrupar y qué sumar sale de las MISMAS funciones que llenan los
    // selectores del cliente, no de un filtro por rol: `columnasDimension`
    // también ofrece los códigos (UPC, Product Code), y filtrar aquí por
    // `rol === "dimension"` dejaba esas opciones sin acumuladores y la gráfica
    // en blanco al elegirlas. Nada que venga de la query entra a un $group.
    const metricas = columnasMetrica(columnas).map((c) => (c as ColumnaResuelta).campo);
    const dimensiones = columnasDimension(columnas).map((c) => (c as ColumnaResuelta).campo);
    const base = { account: ultimo.account, sourceFile: ultimo.sourceFile };
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
      return ok({ metricas, serie: { granularidad, grupos: aGrupos(docs, metricas) } });
    }

    // Una rama por dimensión más la serie mensual y los totales, todo en una
    // sola pasada por la colección y un solo viaje de ida y vuelta.
    const ramas: Record<string, PipelineStage.FacetPipelineStage[]> = {};
    for (const d of dimensiones) ramas[`d_${d}`] = [{ $group: { _id: `$${d}`, ...acc } }];
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

    return ok({
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
      totales,
      rangoFechas:
        desde && hasta
          ? { desde: desde.toISOString().slice(0, 10), hasta: hasta.toISOString().slice(0, 10) }
          : null,
    });
  } catch (e) {
    return handleApiError(e);
  }
}
