// app/layout.tsx

import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { SettingsProvider } from "./providers/SettingsContext";
import { Analytics } from "@vercel/analytics/react";
import { SpeedInsights } from "@vercel/speed-insights/next";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: {
    default: "Estonian Reading Tracker",
    template: "%s | Estonian Reading Tracker",
  },
  description:
    "Follows a child reading Estonian aloud and highlights the current word. Speech recognition runs in the browser; no audio leaves the device.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning={true}>
      <body suppressHydrationWarning={true} className={inter.className}>
        <SettingsProvider>{children}</SettingsProvider>
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );
}
