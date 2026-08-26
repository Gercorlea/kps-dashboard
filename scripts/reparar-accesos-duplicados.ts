// Un proveedor, un correo de acceso.
//
// POR QUÉ EXISTE ESTE SCRIPT. El alta hacía `upsert` por CORREO. Como el
// formulario trae precargado el correo actual, cambiarlo no renombraba el
// acceso: creaba una cuenta nueva y el proveedor se quedaba con dos accesos
// vivos, cada uno con su contraseña. Eso ya está corregido en
// `src/app/api/proveedores/route.ts`, pero los duplicados que quedaron en la
// base hay que quitarlos a mano, y esto es lo que los quita.
//
// CUÁL SE CONSERVA. El que se usó de verdad: el del `lastLoginAt` más
// reciente. Si ninguno ha entrado nunca, el más recién actualizado. Los otros
// se borran, y de cada uno queda copia en la bitácora (`auditLog`) por si hay
// que reponerlo.
//
// Uso:
//   npx tsx --env-file=.env.local scripts/reparar-accesos-duplicados.ts            (simula)
//   npx tsx --env-file=.env.local scripts/reparar-accesos-duplicados.ts --aplicar  (borra)
import mongoose from "mongoose";

const DB = process.env.MONGODB_PROVEEDORES_DB ?? "KPS-Proveedores";
const aplicar = process.argv.includes("--aplicar");

interface Acceso {
  _id: mongoose.Types.ObjectId;
  email: string;
  supplierCode: string;
  roles?: string[];
  active?: boolean;
  lastLoginAt?: Date | null;
  updatedAt?: Date | null;
}

/** Fecha comparable: sin ella, `undefined` ordenaría de forma imprevisible. */
function cuando(v: Date | null | undefined): number {
  return v ? new Date(v).getTime() : 0;
}

function marca(v: Date | null | undefined): string {
  return v ? ` (último acceso ${new Date(v).toISOString().slice(0, 16)})` : " (nunca ha entrado)";
}

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI no está definida (ver .env.example)");

  const conn = await mongoose.createConnection(uri, { dbName: DB }).asPromise();
  const users = conn.collection<Acceso>("users");

  const grupos = await users
    .aggregate<{ _id: string; n: number }>([
      { $match: { supplierCode: { $type: "string" } } },
      { $group: { _id: "$supplierCode", n: { $sum: 1 } } },
      { $match: { n: { $gt: 1 } } },
      { $sort: { _id: 1 } },
    ])
    .toArray();

  if (grupos.length === 0) {
    console.log("✔ Ningún proveedor tiene más de un acceso. Nada que reparar.");
    await conn.close();
    return;
  }

  console.log(
    aplicar
      ? `Proveedores con accesos de más: ${grupos.length}. Se borrarán los sobrantes.`
      : `Proveedores con accesos de más: ${grupos.length}. SIMULACIÓN — no se borra nada.\n  Vuelve a lanzarlo con --aplicar para borrarlos de verdad.`
  );

  let borrados = 0;
  for (const g of grupos) {
    const cuentas = await users.find({ supplierCode: g._id }).toArray();
    // El más usado primero: último login y, a igualdad, última actualización.
    const [conservar, ...sobran] = [...cuentas].sort(
      (a, b) =>
        cuando(b.lastLoginAt) - cuando(a.lastLoginAt) || cuando(b.updatedAt) - cuando(a.updatedAt)
    );

    console.log(`\n${g._id}:`);
    console.log(`  conserva  ${conservar.email}${marca(conservar.lastLoginAt)}`);
    for (const s of sobran) {
      console.log(`  ${aplicar ? "BORRA    " : "borraría "} ${s.email}${marca(s.lastLoginAt)}`);
      if (!aplicar) continue;

      // La bitácora se escribe ANTES de borrar: si algo falla a mitad, queda el
      // rastro de qué había, que es lo único que permitiría reponerlo.
      await conn.collection("auditLog").insertOne({
        entityType: "user",
        entityId: s.email,
        action: "USUARIO_ELIMINADO",
        actorId: "script:reparar-accesos-duplicados",
        actorRole: "superadmin",
        before: { supplierCode: s.supplierCode, roles: s.roles ?? [], active: s.active ?? null },
        after: null,
        comment: `Acceso duplicado de ${s.supplierCode}. Se conserva ${conservar.email}.`,
        createdAt: new Date(),
      });
      await users.deleteOne({ _id: s._id });
      borrados += 1;
    }
  }

  console.log(
    aplicar
      ? `\n✔ Accesos borrados: ${borrados}. Cada uno quedó anotado en la bitácora.`
      : "\nSimulación terminada. Nada se ha modificado."
  );
  await conn.close();
}

main().catch(async (e) => {
  console.error(`✖ ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
