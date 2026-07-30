import type { Metadata } from "next";
import { Hanken_Grotesk, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";

const hankenGrotesk = Hanken_Grotesk({
  variable: "--font-hanken-grotesk",
  subsets: ["latin"],
  weight: ["400", "500", "600", "800"],
});

const ibmPlexMono = IBM_Plex_Mono({
  variable: "--font-ibm-plex-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

export const metadata: Metadata = {
  title: "Cronos Retail — Arcanum",
  description:
    "Dashboard de retail de Arcanum: histórico de ventas, inventario y scorecard de cuenta.",
  icons: { icon: "/ArcanumFavicon.png", apple: "/ArcanumFavicon.png" },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="es" className={`${hankenGrotesk.variable} ${ibmPlexMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
