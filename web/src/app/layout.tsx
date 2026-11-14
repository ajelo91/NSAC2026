import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "PyroSync — Patagonia Andina | Armonización MODIS + VIIRS",
  description:
    "Calendario de Actividad de Quemas 2000–2026 armonizado (MODIS 1 km + VIIRS 375 m) con calibración transferida desde Sierras de Córdoba, susceptibilidad, prevención e International Charter. NASA Space Apps Challenge 2026.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="es">
      <body className="min-h-screen bg-slate-950 text-slate-200 antialiased">{children}</body>
    </html>
  );
}
