import { Schema, model, models, type Model, type Types } from "mongoose";

export interface IUser {
  _id: Types.ObjectId;
  email: string;
  passwordHash: string;
  nombre: string;
  role: "superadmin" | "user";
  modules: string[]; // ["retail", "cronos-ia", "admin"]
  active: boolean;
  resetTokenHash: string | null;
  resetTokenExpiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const UserSchema = new Schema<IUser>(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    nombre: { type: String, required: true, trim: true },
    role: { type: String, enum: ["superadmin", "user"], default: "user" },
    modules: { type: [String], default: [] },
    active: { type: Boolean, default: true },
    // Recuperación de contraseña: token de un solo uso, expiración corta (§5.1)
    resetTokenHash: { type: String, default: null },
    resetTokenExpiresAt: { type: Date, default: null },
  },
  { timestamps: true }
);

export const User: Model<IUser> =
  (models.User as Model<IUser>) ?? model<IUser>("User", UserSchema);
