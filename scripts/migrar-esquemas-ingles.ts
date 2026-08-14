/**
 * Migra los documentos ya guardados en Atlas a los nombres de campo en inglés.
 *
 *   npm run migrar:ingles -- --dry     (muestra el plan, no escribe)
 *   npm run migrar:ingles
 *
 * Mongoose descarta en silencio los campos que no están en el esquema, así que
 * sin esta migración los documentos viejos conservan las claves en español y la
 * aplicación los ve vacíos. No transforma valores de negocio: solo renombra
 * claves y traduce el enum técnico `status`.
 *
 * Es idempotente: $rename solo actúa donde aún existe la clave vieja, así que
 * volver a ejecutarlo no hace nada.
 */
import mongoose from "mongoose";

const SECO = process.argv.includes("--dry");

// Campos comunes a las colecciones de Retail.
const DIMENSIONES = {
  cuenta: "account",
  fechaCorte: "cutoffDate",
  codigoTienda: "storeCode",
  nombreTienda: "storeName",
  idCompuesto: "compositeId",
  descripcion: "description",
  marca: "brand",
  numProveedor: "vendorCode",
  proveedor: "vendorName",
  nombreProveedor: "vendorName",
  fecha: "date",
};

const RENOMBRES: Record<string, Record<string, string>> = {
  ventadiarias: { ...DIMENSIONES, unidades: "units" },
  pronosticosemanals: { ...DIMENSIONES, semanaInicio: "weekStart", valor: "value" },
  forecastdiarios: { ...DIMENSIONES, valor: "value" },
  stockcedis: {
    ...DIMENSIONES,
    disponibilidadRealCD: "realAvailabilityDC",
    transitos: "inTransit",
    sinCita: "withoutAppointment",
    citas: "appointments",
    caracteristicaPlan: "planCharacteristic",
    minimo: "minimum",
    cobertura: "coverage",
    puntoPedido: "reorderPoint",
    stockObjetivo: "targetStock",
  },
  stockfarmacias: {
    ...DIMENSIONES,
    tipoArticulo: "itemType",
    stockSegMin: "minSafetyStock",
    cobertObjMin: "minTargetCoverage",
    stockObjetivo: "targetStock",
    puntoPedido: "reorderPoint",
    stockDinamico: "dynamicStock",
    stockMaximo: "maxStock",
    libreUtilizacion: "unrestrictedStock",
    transitoFarma: "pharmacyInTransit",
    nivelInventario: "inventoryLevel",
  },
  lineaocs: {
    ...DIMENSIONES,
    documentoCompras: "purchaseDoc",
    posicion: "lineNumber",
    fechaPedido: "orderDate",
    cantidadReparto: "allocatedQty",
    unidadMedida: "uom",
    cantidadEntregada: "deliveredQty",
    fechaEntrega: "deliveryDate",
    estatusOC: "poStatus",
    negociador: "buyer",
    pedidoEnUMA: "orderInUMA",
    ciDoctoCompras: "purchaseDocRef",
  },
  uploads: {
    cuenta: "account",
    fechaCorte: "cutoffDate",
    hojasDetectadas: "detectedSheets",
    resumen: "summary",
    incidencias: "issues",
    subidoPor: "uploadedBy",
  },
  users: { nombre: "name" },
  chats: { titulo: "title" },
  // Con el nombre viejo: los campos se migran antes de renombrar la colección.
  reporteventas: { plantilla: "template" },
  mensajes: {
    rol: "role",
    contenido: "content",
    modelo: "model",
    tokensEntrada: "inputTokens",
    tokensSalida: "outputTokens",
    costoUSD: "costUSD",
    herramientas: "tools",
  },
};

// $rename no entra en arreglos: estos se reescriben documento a documento.
const EMBEBIDOS: Record<string, { campo: string; claves: Record<string, string> }[]> = {
  uploads: [
    { campo: "issues", claves: { hoja: "sheet", fila: "row", campo: "field", mensaje: "message" } },
  ],
  stockcedis: [{ campo: "appointments", claves: { fecha: "date", cantidad: "quantity" } }],
  mensajes: [{ campo: "tools", claves: { nombre: "name", resultado: "result" } }],
};

// Nombres de colección que Mongoose deriva de los modelos renombrados.
const COLECCIONES: Record<string, string> = {
  ventadiarias: "dailysales",
  pronosticosemanals: "weeklyforecasts",
  forecastdiarios: "dailyforecasts",
  stockcedis: "dcstocks",
  stockfarmacias: "pharmacystocks",
  lineaocs: "purchaseorderlines",
  mensajes: "messages",
  reporteventas: "salesreports",
};

const ESTADOS: Record<string, string> = {
  pendiente: "pending",
  procesando: "processing",
  procesado: "processed",
};

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("Falta MONGODB_URI");
  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  if (!db) throw new Error("Sin conexión a la base");
  console.log(`Base: ${db.databaseName}${SECO ? "  (simulación, no escribe)" : ""}\n`);

  let existentes = new Set((await db.listCollections().toArray()).map((c) => c.name));

  // Primero los campos (con los nombres viejos de colección), después el
  // renombrado de la colección: al revés habría que duplicar el mapa.

  for (const [coleccion, mapa] of Object.entries(RENOMBRES)) {
    if (!existentes.has(coleccion)) {
      console.log(`- ${coleccion}: no existe, se omite`);
      continue;
    }
    const col = db.collection(coleccion);
    const pendientes: Record<string, number> = {};
    for (const viejo of Object.keys(mapa)) {
      const n = await col.countDocuments({ [viejo]: { $exists: true } });
      if (n) pendientes[viejo] = n;
    }

    if (!Object.keys(pendientes).length) {
      console.log(`✔ ${coleccion}: ya migrada`);
    } else {
      console.log(`→ ${coleccion}: ${JSON.stringify(pendientes)}`);
      if (!SECO) {
        // Un $rename por campo: dos claves viejas pueden apuntar a la misma
        // nueva (proveedor / nombreProveedor) y hacerlo junto daría conflicto.
        for (const [viejo, nuevo] of Object.entries(mapa)) {
          if (!pendientes[viejo]) continue;
          const r = await col.updateMany(
            { [viejo]: { $exists: true }, [nuevo]: { $exists: false } },
            { $rename: { [viejo]: nuevo } }
          );
          if (r.modifiedCount) console.log(`    ${viejo} → ${nuevo}: ${r.modifiedCount}`);
        }
      }
    }

    for (const emb of EMBEBIDOS[coleccion] ?? []) {
      const docs = await col.find({ [emb.campo]: { $type: "array" } }).toArray();
      let tocados = 0;
      for (const doc of docs) {
        const arreglo = doc[emb.campo] as Record<string, unknown>[];
        let cambio = false;
        const nuevo = arreglo.map((item) => {
          const salida: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(item)) {
            const destino = emb.claves[k] ?? k;
            if (destino !== k) cambio = true;
            salida[destino] = v;
          }
          return salida;
        });
        if (cambio) {
          tocados++;
          if (!SECO) await col.updateOne({ _id: doc._id }, { $set: { [emb.campo]: nuevo } });
        }
      }
      if (tocados) console.log(`    ${emb.campo}[]: ${tocados} documentos`);
    }
  }

  if (existentes.has("uploads")) {
    const col = db.collection("uploads");
    for (const [viejo, nuevo] of Object.entries(ESTADOS)) {
      const n = await col.countDocuments({ status: viejo });
      if (!n) continue;
      console.log(`→ uploads.status "${viejo}" → "${nuevo}": ${n}`);
      if (!SECO) await col.updateMany({ status: viejo }, { $set: { status: nuevo } });
    }
  }

  for (const [viejo, nuevo] of Object.entries(COLECCIONES)) {
    if (!existentes.has(viejo)) continue;
    if (existentes.has(nuevo)) {
      console.log(`⚠ ${viejo} → ${nuevo}: el destino ya existe, se omite`);
      continue;
    }
    const n = await db.collection(viejo).countDocuments();
    console.log(`→ colección ${viejo} → ${nuevo} (${n} docs)`);
    if (!SECO) await db.collection(viejo).rename(nuevo);
  }
  existentes = new Set((await db.listCollections().toArray()).map((c) => c.name));

  console.log(SECO ? "\nSimulación terminada: no se escribió nada." : "\nMigración terminada.");
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
