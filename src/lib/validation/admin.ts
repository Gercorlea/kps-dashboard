import { z } from "zod";
import { MODULE_IDS, type ModuleId } from "@/lib/rbac";

const moduleEnum = z.enum(MODULE_IDS as [ModuleId, ...ModuleId[]]);

export const createUserSchema = z.object({
  email: z.email({ message: "Correo inválido" }).max(160),
  nombre: z.string().min(1, "El nombre es obligatorio").max(120),
  password: z.string().min(8, "Mínimo 8 caracteres").max(100),
  modules: z.array(moduleEnum).default([]),
  active: z.boolean().default(true),
});

export const updateUserSchema = z.object({
  nombre: z.string().min(1).max(120).optional(),
  modules: z.array(moduleEnum).optional(),
  active: z.boolean().optional(),
});

// Acciones puntuales sobre un usuario (§10 /admin/usuarios)
export const userActionSchema = z.object({
  accion: z.enum(["reset-password", "revocar-sesiones"]),
});
