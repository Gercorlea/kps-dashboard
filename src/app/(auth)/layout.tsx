import { BrandMark } from "@/components/ui/BrandMark";

// Panel centrado sobre el lienzo gris. UNA sola marca: antes iban el isotipo y
// el logotipo juntos, y desde que la variante `word` es el lockup de KPS los
// dos mostraban lo mismo. Tampoco va ya el rotulo "Cronos Retail": el producto
// se llama KPS en la barra lateral, y dos nombres distintos para la misma app
// es peor que ninguno.
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="flex min-h-dvh items-center justify-center p-4"
      style={{ background: "var(--cr-bg)" }}
    >
      <div className="cr-card w-full max-w-sm p-8">
        <div className="mb-6 flex justify-center">
          <BrandMark variant="word" tone="ink" height={54} priority />
        </div>
        {children}
      </div>
    </div>
  );
}
