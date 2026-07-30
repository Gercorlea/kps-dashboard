import mongoose from "mongoose";

// Patrón serverless obligatorio (§5.5): la conexión se cachea en `global`
// para sobrevivir hot-reload en dev y reuso de lambdas en Vercel.
const uri = process.env.MONGODB_URI!;

type MongooseCache = {
  conn: typeof mongoose | null;
  promise: Promise<typeof mongoose> | null;
};

const globalWithMongoose = global as typeof globalThis & {
  _mongoose?: MongooseCache;
};

const cached: MongooseCache = globalWithMongoose._mongoose ?? {
  conn: null,
  promise: null,
};
globalWithMongoose._mongoose = cached;

export async function connectDB() {
  if (cached.conn) return cached.conn;
  if (!cached.promise) {
    if (!uri) {
      throw new Error("MONGODB_URI no está definida (ver .env.example)");
    }
    // Si la conexión falla, se limpia la promesa cacheada para que el
    // siguiente request reintente en lugar de quedar rechazada para siempre.
    cached.promise = mongoose
      .connect(uri, { bufferCommands: false, serverSelectionTimeoutMS: 8000 })
      .catch((e) => {
        cached.promise = null;
        throw e;
      });
  }
  cached.conn = await cached.promise;
  return cached.conn;
}
