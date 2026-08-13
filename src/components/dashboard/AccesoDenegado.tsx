import { BrandMark } from "@/components/ui/BrandMark";
import { PageHeader } from "@/components/dashboard/PageHeader";

// Pantalla 403 de página: el guard real del backend responde 403 en la
// API aunque el usuario nunca vea el link (§5.4).
export function AccesoDenegado({ modulo }: { modulo: string }) {
  return (
    <>
      <PageHeader title="Acceso denegado" />
      <div className="cr-page-content">
        <div className="cr-panel">
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <BrandMark variant="mark" tone="ink" height={32} />
            <p className="cr-h3">No tienes acceso al módulo {modulo}</p>
            <p className="cr-body max-w-sm">
              Pide a un administrador que te asigne el módulo desde Usuarios.
            </p>
          </div>
        </div>
      </div>
    </>
  );
}
