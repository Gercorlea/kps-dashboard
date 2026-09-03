import Image from "next/image";

// Marca Arcanum (§4.8). Regla única de contraste: variante Black sobre
// fondo claro, White sobre fondo oscuro — nunca al revés. Nada de emojis,
// iniciales ni iconos Lucide como marca del producto.

type Variant = "mark" | "word";
type Tone = "ink" | "white";

const ARCHIVOS: Record<Variant, Record<Tone, string>> = {
  mark: { ink: "/ArcanumBlackLogo.png", white: "/ArcanumWhiteLogo.png" },
  word: { ink: "/ArcanumTextBlack.png", white: "/ArcanumTextWhite.png" },
};

// Relación de aspecto por variante para fijar width/height y evitar
// layout shift (isotipo cuadrado; logotipo horizontal). Los valores salen de
// los PNG reales de public/ —isotipo 1000×1000, logotipo 1350×385—: si no
// coinciden, el `width` que se declara aquí no cuadra con el que el navegador
// calcula por `width: auto` y next/image avisa de la relación de aspecto rota.
const RATIO: Record<Variant, number> = { mark: 1, word: 1350 / 385 };

export function BrandMark({
  variant = "mark",
  tone = "ink",
  height = 28,
  priority = false,
  className,
}: {
  variant?: Variant;
  tone?: Tone;
  height?: number;
  priority?: boolean;
  className?: string;
}) {
  const width = Math.round(height * RATIO[variant]);
  return (
    <Image
      src={ARCHIVOS[variant][tone]}
      alt="Arcanum"
      width={width}
      height={height}
      priority={priority}
      className={className}
      style={{ height, width: "auto" }}
    />
  );
}
