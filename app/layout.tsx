import type { Metadata } from "next";
import { Geist, Geist_Mono, Rubik } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Sentry's product font, used only inside the Seer review widget.
const rubik = Rubik({
  variable: "--font-rubik",
  subsets: ["latin"],
});

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const base = new URL(`${protocol}://${host}`);
  const socialImage = new URL("/og.jpg", base).toString();

  return {
    metadataBase: base,
    title: {
      default: "Pawn Patrol — Live chess",
      template: "%s · Pawn Patrol",
    },
    description: "Start a private chess table, share the code, and play live.",
    icons: {
      icon: "/pawn-patrol-sentry-correct.png",
      shortcut: "/pawn-patrol-sentry-correct.png",
    },
    openGraph: {
      title: "Pawn Patrol",
      description: "Live chess, one move at a time.",
      images: [{ url: socialImage, width: 1200, height: 630, type: "image/jpeg" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "Pawn Patrol",
      description: "Live chess, one move at a time.",
      images: [socialImage],
    },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable} ${rubik.variable}`}>{children}</body>
    </html>
  );
}
