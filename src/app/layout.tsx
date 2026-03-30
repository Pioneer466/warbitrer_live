import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "Paper BTC 15m Arb",
  description:
    "Dashboard paper-only pour suivre les opportunités cross-venue BTC 15 minutes entre Polymarket et Kalshi.",
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
