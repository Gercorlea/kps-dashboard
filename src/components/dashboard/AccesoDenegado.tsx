import { BrandMark } from "@/components/ui/BrandMark";
import { EstadoVacio, Panel } from "@/components/ui/basicos";
import { Pagina } from "@/components/dashboard/Pagina";

// Pantalla 403 de página: el guard real del backend responde 403 en la
// API aunque el usuario nunca vea el link (§5.4).
//
// Se arma con las piezas base —<Pagina>, <Panel>, <EstadoVacio>— y no con
// markup propio: antes repetía a mano el mismo bloque centrado que ya tenía
// EstadoVacio, así que un cambio de estilo en los estados vacíos se olvidaba
// justo aquí.
export function AccesoDenegado({ modulo }: { modulo: string }) {
  return (
    <Pagina title="Acceso denegado">
      <Panel>
        <EstadoVacio
          title={`No tienes acceso al módulo ${modulo}`}
          detalle="Pide a un administrador que te asigne el módulo desde Usuarios."
        >
          <BrandMark variant="mark" tone="ink" height={32} />
        </EstadoVacio>
      </Panel>
    </Pagina>
  );
}
