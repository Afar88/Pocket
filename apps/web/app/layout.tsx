import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Pocket — money for your people",
  description: "Recurring cNGN payments from your own Altana wallet on Celo."
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
