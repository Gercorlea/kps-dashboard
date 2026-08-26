// Volcado inicial (y resincronización manual) de las líneas de factura de
// SAP hacia MongoDB. Uso: npm run sap:facturas
//
// La primera corrida recorre todo el histórico (~450 peticiones al Service
// Layer, unos 40 s); las siguientes solo traen facturas nuevas. El chat
// también resincroniza solo (throttle de 5 min), así que este script es para
// el arranque y para reparar, no para operar a diario.
import mongoose from "mongoose";
import { sincronizarFacturas } from "../src/lib/sap/sincronizar-facturas";

async function main() {
  const inicio = Date.now();
  const r = await sincronizarFacturas();
  const segundos = ((Date.now() - inicio) / 1000).toFixed(1);
  console.log(
    `✔ ${r.facturas} facturas revisadas (DocEntry > ${r.desdeDocEntry}), ` +
      `${r.lineas} líneas escritas en ${segundos}s`
  );
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error("✖ Sincronización fallida:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
