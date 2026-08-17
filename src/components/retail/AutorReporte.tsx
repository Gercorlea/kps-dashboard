// Quién subió o escribió un reporte, tal como se muestra en la lista de
// reportes de un retailer y en la ficha de uno.
//
// Vive aparte porque lo usan las dos vistas: la lista sólo necesita el nombre y
// la ficha además atribuye la última actualización. Sin "use client": entra al
// bundle de cliente por quien lo importa.

/** Autor de un reporte, como lo devuelve la API (@/lib/usuarios). */
export interface UsuarioReporte {
  id: string;
  nombre: string;
  email: string;
  rol: string;
}

/**
 * Nombre y correo del autor. El correo va debajo porque dos personas pueden
 * llamarse igual y es lo que distingue una cuenta de otra.
 *
 * Un autor sin resolver es un usuario borrado: se dice así en vez de inventarle
 * un nombre o dejar la celda vacía, que se leería como "nadie lo subió".
 */
export function AutorReporte({ usuario }: { usuario: UsuarioReporte | null }) {
  if (!usuario) return <span className="cr-small">Usuario no disponible</span>;
  return (
    <>
      <span className="block truncate" title={usuario.email}>
        {usuario.nombre}
      </span>
      <span className="cr-small block truncate">
        {usuario.rol === "superadmin" ? "Superadmin · " : ""}
        {usuario.email}
      </span>
    </>
  );
}
