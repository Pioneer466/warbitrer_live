import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "Warbitrer Live Multi-Asset 15m",
  description: "Cockpit live pour la stratégie d'arbitrage crypto 15 minutes entre Polymarket et Kalshi.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="fr">
      <body className="bg-ink text-white antialiased">{children}</body>
    </html>
  );
}
