import type { Types } from "mongoose";
import { User } from "@/models/User";

// Resolver ObjectIds de usuario a algo que se pueda mostrar en pantalla.
//
// Los documentos de negocio guardan sólo el id de quien los escribió (§5.1), así
// que la interfaz necesita traducirlo a nombre. Se resuelve en un solo `find`
// por respuesta y no con `populate` fila a fila: quien subió un reporte se
// repite en las 15 mil filas de ese reporte.

/** Autor de un documento, tal como lo muestra la interfaz. */
export interface UsuarioResumen {
  id: string;
  nombre: string;
  email: string;
  rol: string;
}

/**
 * Mapa id → autor para los ids dados. Los que ya no existen (usuario borrado)
 * simplemente no aparecen: quien lo lea muestra "—" en vez de inventar un
 * nombre. Requiere que el llamador ya haya hecho `connectDB()`.
 */
export async function usuariosPorId(
  ids: Array<Types.ObjectId | string | null | undefined>
): Promise<Map<string, UsuarioResumen>> {
  const unicos = [...new Set(ids.filter(Boolean).map(String))];
  if (unicos.length === 0) return new Map();

  const docs = await User.find({ _id: { $in: unicos } })
    .select({ name: 1, email: 1, role: 1 })
    .lean();

  return new Map(
    docs.map((u) => [
      String(u._id),
      { id: String(u._id), nombre: u.name, email: u.email, rol: u.role },
    ])
  );
}
