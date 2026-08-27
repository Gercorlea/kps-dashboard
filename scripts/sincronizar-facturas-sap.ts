// Volcado inicial (y resincronización manual) de las líneas de factura de
// SAP hacia MongoDB, con sus lotes.
//   npm run sap:facturas               facturas nuevas desde la última copiada
//   npm run sap:facturas -- --completo recorre todo el histórico (idempotente):
//                                      hace falta UNA vez para rellenar los lotes
//                                      de las facturas copiadas antes de existir
//                                      la colección de lotes.
//
// La primera corrida recorre todo el histórico (~450 peticiones al Service
// Layer, unos 40 s); las siguientes solo traen facturas nuevas. El chat
// también resincroniza solo (throttle de 5 min), así que este script es para
// el arranque y para reparar, no para operar a diario.
import mongoose from "mongoose";
import { sincronizarFacturas } from "../src/lib/sap/sincronizar-facturas";

async function main() {
  const inicio = Date.now();
  const r = await sincronizarFacturas({ desdeCero: process.argv.includes("--completo") });
  const segundos = ((Date.now() - inicio) / 1000).toFixed(1);
  console.log(
    `✔ ${r.facturas} facturas revisadas (DocEntry > ${r.desdeDocEntry}), ` +
      `${r.lineas} líneas y ${r.lotes} lotes escritos en ${segundos}s`
  );
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error("✖ Sincronización fallida:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
