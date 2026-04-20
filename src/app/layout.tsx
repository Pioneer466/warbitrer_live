import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "Warbitrer Live BTC + ETH 15m",
  description:
    "Cockpit live pour la stratégie d'arbitrage BTC et ETH 15 minutes entre Polymarket et Kalshi.",
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
