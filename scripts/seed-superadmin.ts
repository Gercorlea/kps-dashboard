// Seed protegido del superadmin (§5.4): lee credenciales de env y FALLA
// si ya existe. Uso: npm run seed:superadmin
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import { MODULE_IDS } from "../src/lib/rbac";
import { User } from "../src/models/User";

async function main() {
  const email = process.env.SEED_SUPERADMIN_EMAIL?.toLowerCase();
  const password = process.env.SEED_SUPERADMIN_PASSWORD;
  const uri = process.env.MONGODB_URI;

  if (!uri) throw new Error("MONGODB_URI no está definida (ver .env.example)");
  if (!email || !password) {
    throw new Error(
      "Faltan SEED_SUPERADMIN_EMAIL o SEED_SUPERADMIN_PASSWORD (ver .env.example)"
    );
  }
  if (password.length < 8) {
    throw new Error("SEED_SUPERADMIN_PASSWORD debe tener al menos 8 caracteres");
  }

  await mongoose.connect(uri);

  const existente = await User.findOne({ role: "superadmin" }).lean();
  if (existente) {
    throw new Error(`Ya existe un superadmin (${existente.email}). El seed no se repite.`);
  }

  await User.create({
    email,
    nombre: "Superadmin",
    passwordHash: await bcrypt.hash(password, 12),
    role: "superadmin",
    modules: [...MODULE_IDS],
    active: true,
  });

  console.log(`✔ Superadmin creado: ${email}`);
  console.log("  Cambia la contraseña tras el primer login.");
}

main()
  .then(() => mongoose.disconnect())
  .catch(async (e) => {
    console.error(`✖ ${e instanceof Error ? e.message : e}`);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  });
