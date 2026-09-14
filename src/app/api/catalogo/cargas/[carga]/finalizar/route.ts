import type { NextRequest } from "next/server";
import { ApiError, handleApiError, ok, parseJson } from "@/lib/api";
import { requireModule } from "@/lib/auth/guards";
import { barrerCargas, borrarFilasDeCarga } from "@/lib/catalogo/cargas";
import { connectDB } from "@/lib/db";
import { finalizarCargaSchema } from "@/lib/validation/catalogo";
import { CatalogLoad, type ICatalogLoad } from "@/models/CatalogLoad";
import { CatalogProduct } from "@/models/CatalogProduct";
import { ProductMapping } from "@/models/ProductMapping";

// POST /api/catalogo/cargas/[carga]/finalizar — activa la carga y retira la anterior.
//
// Es el único punto donde el catálogo que ve el módulo cambia. El orden de las
// escrituras es deliberado y está explicado paso a paso: mal ordenado, deja el
// módulo en blanco durante el reemplazo o activa un catálogo incompleto.

function resumenDeCarga(doc: ICatalogLoad) {
  return {
    loadId: doc.loadId,
    filename: doc.filename,
    productos: doc.productCount,
    mapeos: doc.mappingCount,
    huerfanos: doc.orphanMappings,
    descartados: { productos: doc.discardedProducts, mapeos: doc.discardedMappings },
    incidencias: doc.issues,
    finalizadaEl: doc.finalizedAt?.toISOString() ?? null,
  };
}

/** skus de la hoja de mapeo que no tienen producto en la misma carga. */
async function contarHuerfanos(loadId: string): Promise<number> {
  const [skus, items] = await Promise.all([
    ProductMapping.distinct("sku", { loadId }),
    CatalogProduct.distinct("item", { loadId }),
  ]);
  const enCatalogo = new Set(items as string[]);
  return (skus as string[]).filter((s) => !enCatalogo.has(s)).length;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ carga: string }> }
) {
  try {
    const usuario = await requireModule("catalogo");
    const { carga } = await params;
    const { incidencias, loadIdPrevio } = await parseJson(request, finalizarCargaSchema);
    await connectDB();

    const doc = await CatalogLoad.findOne({ loadId: carga }).lean<ICatalogLoad | null>();
    if (!doc) throw new ApiError(404, "CARGA_NO_ENCONTRADA", "La carga no existe.");
    // Reintentar finalizar es idempotente: si ya está activa, no hay nada que
    // hacer y devolver un error asustaría sin motivo.
    if (doc.status === "active") return ok({ ...resumenDeCarga(doc), reemplazo: null, reemplazoInesperado: false, filasBorradas: 0 });
    if (doc.status !== "loading") {
      throw new ApiError(409, "CARGA_CERRADA", "Esta carga ya se cerró; empieza una nueva.");
    }
    if (String(doc.uploadedBy) !== usuario.id) {
      throw new ApiError(403, "SIN_PERMISO", "Esta carga la abrió otra persona.");
    }

    // 1. Contar lo que REALMENTE quedó escrito, no lo que el cliente declaró.
    const [productCount, mappingCount] = await Promise.all([
      CatalogProduct.countDocuments({ loadId: carga }),
      ProductMapping.countDocuments({ loadId: carga }),
    ]);

    // 2. Una carga incompleta NO se activa. Es lo que atrapa "se perdió un lote
    //    por la red": activarla dejaría un catálogo al que le faltan productos
    //    sin que nada lo dijera, y eso es peor que no haber subido nada.
    if (productCount === 0 || productCount < doc.declaredProducts) {
      await CatalogLoad.updateOne({ loadId: carga }, { $set: { status: "failed" } });
      await borrarFilasDeCarga(carga);
      throw new ApiError(
        409,
        "CARGA_INCOMPLETA",
        `Se esperaban ${doc.declaredProducts} productos y llegaron ${productCount}. ` +
          "El catálogo anterior sigue intacto; vuelve a subir el archivo."
      );
    }

    // 3. Huérfanos: es un aviso, no un error (el mapeo lo mantiene otra persona
    //    y llevar retraso respecto al catálogo es normal).
    const orphanMappings = mappingCount === 0 ? 0 : await contarHuerfanos(carga);

    // 4. ACTIVAR. El filtro por status hace la operación atómica frente a un
    //    segundo finalizar concurrente: sólo uno pasa de loading a active.
    const finalizedAt = new Date();
    const activada = await CatalogLoad.updateOne(
      { loadId: carga, status: "loading" },
      {
        $set: {
          status: "active",
          finalizedAt,
          productCount,
          mappingCount,
          orphanMappings,
          issues: incidencias,
          replacedLoadId: loadIdPrevio,
        },
      }
    );
    if (activada.matchedCount === 0) {
      // Otro finalizar ganó la carrera y ya la dejó activa.
      const actual = await CatalogLoad.findOne({ loadId: carga }).lean<ICatalogLoad | null>();
      if (!actual) throw new ApiError(404, "CARGA_NO_ENCONTRADA", "La carga desapareció.");
      return ok({ ...resumenDeCarga(actual), reemplazo: null, reemplazoInesperado: false, filasBorradas: 0 });
    }

    // 5. Degradar las activas anteriores. DESPUÉS de activar la nueva, nunca
    //    antes: entre el paso 4 y este hay un instante con dos activas, y la
    //    lectura toma la más reciente (ver cargaActiva). Al revés habría un
    //    instante SIN ninguna activa, y si esta escritura fallara el módulo se
    //    quedaría en blanco con el catálogo nuevo ya escrito.
    const previas = await CatalogLoad.find({ status: "active", loadId: { $ne: carga } })
      .select({ loadId: 1 })
      .sort({ finalizedAt: -1 })
      .lean();
    if (previas.length > 0) {
      await CatalogLoad.updateMany(
        { loadId: { $in: previas.map((p) => p.loadId) } },
        { $set: { status: "replaced", replacedAt: new Date() } }
      );
    }

    // 6. Barrido de todo lo que ya no vige. Si falla, las filas quedan
    //    huérfanas pero INVISIBLES y el siguiente finalizar las limpia; por eso
    //    el módulo no necesita un cron.
    const filasBorradas = await barrerCargas();

    const reemplazo = previas[0]?.loadId ?? null;
    return ok({
      loadId: carga,
      filename: doc.filename,
      productos: productCount,
      mapeos: mappingCount,
      huerfanos: orphanMappings,
      descartados: { productos: doc.discardedProducts, mapeos: doc.discardedMappings },
      incidencias,
      finalizadaEl: finalizedAt.toISOString(),
      reemplazo,
      // Alguien subió un catálogo mientras este archivo se estaba leyendo. No se
      // impide —el último gana, que es lo que significa "reemplaza al anterior"—
      // pero quien sube tiene que saber que acaba de tirar el trabajo de otro.
      reemplazoInesperado: reemplazo !== null && loadIdPrevio !== null && reemplazo !== loadIdPrevio,
      filasBorradas,
    });
  } catch (e) {
    return handleApiError(e);
  }
}
