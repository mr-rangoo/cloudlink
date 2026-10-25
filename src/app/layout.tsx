import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import { Toaster } from "sonner";
import { ThemeSync } from "@/components/shell/theme-sync";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Cloudlink", template: "%s · Cloudlink" },
  description: "Cloudlink ISP billing, subscriber management and network operations.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f6f8fb" },
    { media: "(prefers-color-scheme: dark)", color: "#0a111e" },
  ],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const theme = (await cookies()).get("cloudlink_theme")?.value;
  const mode = theme === "dark" || theme === "light" || theme === "system" ? theme : "light";
  return (
    <html lang="en" className={mode === "dark" ? "dark" : undefined} suppressHydrationWarning>
      <body>
        {mode === "system" ? <ThemeSync /> : null}
        {children}
        <Toaster position="top-right" richColors closeButton />
      </body>
    </html>
  );
}
