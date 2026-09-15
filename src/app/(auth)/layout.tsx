import { BrandMark } from "@/components/ui/BrandMark";

// Panel centrado sobre el lienzo gris. UNA sola marca: antes iban el isotipo y
// el logotipo juntos, y desde que la variante `word` es el lockup de KPS los
// dos mostraban lo mismo. Tampoco va ya el rotulo "Cronos Retail": el producto
// se llama KPS en la barra lateral, y dos nombres distintos para la misma app
// es peor que ninguno.
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="cr-auth">
      {/* Aqui habia un `p-8` que si estaba dando los 32px de padding, porque
          .cr-card no traia ninguno. Al pasar .cr-card a 18px (canon CRONOS: una
          sola medida para todas las cards) el `p-8` dejo de tener efecto:
          design-system.css va sin @layer y Tailwind mete sus utilidades en
          @layer utilities, asi que lo no-capado gana. Se quita para que el
          markup no mienta. Esta card ahora mide 18px como el resto. */}
      <section className="cr-auth__card">
        <div className="cr-auth__marca">
          <BrandMark variant="word" tone="ink" height={44} priority />
        </div>
        {children}
      </section>
    </main>
  );
}
