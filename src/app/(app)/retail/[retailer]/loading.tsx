import {
  RetailerCabeceraSkeleton,
  RetailerContenidoSkeleton,
} from "@/components/retail/RetailerSkeleton";

// Fallback de la ficha del retailer mientras el servidor la arma: la sesión más
// el agregado de detalleRetailers(), que es lo que se hacía esperar sin dar
// ninguna señal — el clic se quedaba en /retail hasta que Mongo contestaba.
//
// Next envuelve page.tsx en un <Suspense> con esto de fallback, y a los
// componentes de loading no les llegan params (ver
// node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/loading.md):
// de ahí que el esqueleto no pueda adelantar el nombre del retailer.
//
// El aviso de esos docs —"si el layout lee datos de runtime, el fallback no se
// muestra"— no aplica al caso que importa: al venir de /retail, (app)/layout.tsx
// es segmento compartido y no se vuelve a renderizar; lo único que cambia es
// [retailer]. Y `unstable_instant` no hace falta porque el proyecto no tiene
// Cache Components activado en next.config.ts.
export default function Loading() {
  return (
    <>
      <RetailerCabeceraSkeleton />
      <div className="cr-page-content flex flex-col gap-5">
        <RetailerContenidoSkeleton />
      </div>
    </>
  );
}
