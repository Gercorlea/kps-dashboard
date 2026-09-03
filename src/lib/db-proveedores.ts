import mongoose from "mongoose";

// Segunda conexión: la base del Portal de Proveedores.
//
// POR QUÉ NO SE REUSA `connectDB()`. Ese apunta a `cronos-retail`, donde vive
// todo lo del dashboard. El portal usa otra base del MISMO cluster,
// `KPS-Proveedores`, y las dos tienen una colección `users` con esquemas
// distintos e incompatibles: aquí es `role: superadmin|user` + `modules[]`,
// allí es `roles: UserRole[]` + `supplierCode`. Escribir una sobre otra
// rompería el login de los dos proyectos.
//
// Por eso una conexión separada y no un cambio de base sobre la existente:
// `mongoose.connect()` es global al proceso, así que reapuntarla se llevaría
// por delante los modelos de retail.

const uri = process.env.MONGODB_URI!;

/** Base del portal. Se puede cambiar sin tocar la del dashboard. */
const DB_PROVEEDORES = process.env.MONGODB_PROVEEDORES_DB ?? "KPS-Proveedores";

type Cache = { conn: mongoose.Connection | null };

const globalWithConn = global as typeof globalThis & {
  _mongooseProveedores?: Cache;
};

const cached: Cache = globalWithConn._mongooseProveedores ?? { conn: null };
globalWithConn._mongooseProveedores = cached;

export function connectProveedoresDB(): mongoose.Connection {
  if (cached.conn) return cached.conn;
  if (!uri) {
    throw new Error("MONGODB_URI no está definida (ver .env.example)");
  }
  // `createConnection` es síncrono y encola las operaciones hasta que abre, así
  // que no hace falta await aquí. `dbName` pisa la base que traiga el URI en la
  // ruta: el URI apunta a cronos-retail y esta conexión tiene que ir a la otra.
  cached.conn = mongoose.createConnection(uri, {
    dbName: DB_PROVEEDORES,
    serverSelectionTimeoutMS: 8000,
  });
  return cached.conn;
}

export { DB_PROVEEDORES };
