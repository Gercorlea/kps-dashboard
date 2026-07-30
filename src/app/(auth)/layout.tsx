import { BrandMark } from "@/components/ui/BrandMark";

// Panel centrado sobre canvas gris; logo en variante tinta porque el
// panel es blanco (§4.8).
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="flex min-h-dvh items-center justify-center p-4"
      style={{ background: "var(--cr-canvas)" }}
    >
      <div className="cr-card w-full max-w-sm p-8">
        <div className="mb-6 flex flex-col items-center gap-3">
          <BrandMark variant="mark" tone="ink" height={36} priority />
          <BrandMark variant="word" tone="ink" height={14} />
          <span className="cr-label">Cronos Retail</span>
        </div>
        {children}
      </div>
    </div>
  );
}
