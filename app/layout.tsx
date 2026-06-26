import type { Metadata } from "next";
import { Space_Mono, Orbitron } from "next/font/google";
import { Toaster } from "sonner";
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { ThemeProvider } from "@/components/theme/ThemeProvider";
import { ThemeScript } from "@/components/theme/ThemeScript";
import "./globals.css";

// UI font — monospace, used everywhere except the hero wordmark.
const spaceMono = Space_Mono({
  subsets: ["latin"],
  weight: ["400", "700"],
  variable: "--font-ui",
  display: "swap",
});

// Hero font — futuristic display, used for wordmarks and large headings.
const orbitron = Orbitron({
  subsets: ["latin"],
  weight: ["500", "700", "800", "900"],
  variable: "--font-hero",
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "CG Signal — Team Blog Newsletter",
    template: "%s · CG Signal",
  },
  description: "Daily signals from the ConveGenius.ai team — notes, retros, launches, and experiments.",
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"),
  robots: { index: true, follow: true },
  icons: {
    icon: "/cg.png",
    shortcut: "/cg.png",
    apple: "/cg.png",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // `suppressHydrationWarning` on <html> is required because the pre-hydration
  // ThemeScript mutates the `data-theme` attribute before React mounts.
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${spaceMono.variable} ${orbitron.variable}`}
    >
      <head>
        {/* Render-blocking preboot script — runs before <body> parses so the
            visible theme matches the user's persisted choice without a flash of
            the wrong colours. Lives in <head> (not <body>) because React 19
            only executes inline scripts from the server-rendered HTML, and warns
            when an inline <script> is reconciled inside the body tree. */}
        <ThemeScript />
      </head>
      <body className="min-h-screen bg-portal-main text-portal-text antialiased">
        <ThemeProvider>{children}</ThemeProvider>
        <Toaster
          // Sonner reads this once; the toast surface itself is themed by the
          // CSS variables it inherits via `toastOptions.style` below.
          theme="system"
          richColors
          position="top-right"
          toastOptions={{
            style: {
              background: "var(--bg-panel-raised)",
              border: "1px solid var(--border-muted)",
              color: "var(--text-main)",
              fontFamily: "var(--font-ui), monospace",
            },
          }}
        />
        {/* Vercel-managed analytics. Both packages are SSR-safe and inject
            their tracking script only in production builds (and only on
            Vercel-hosted deployments), so dev/preview/self-hosted builds
            stay clean. */}
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );
}
