import { z } from "zod";

export const loginSchema = z.object({
  email: z.email({ message: "Correo inválido" }).max(160),
  password: z.string().min(1, "La contraseña es obligatoria").max(100),
});

export const recuperarSchema = z.object({
  email: z.email({ message: "Correo inválido" }).max(160),
});

export const restablecerSchema = z.object({
  token: z.string().min(16).max(200),
  password: z.string().min(8, "Mínimo 8 caracteres").max(100),
});
