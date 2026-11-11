import type { Metadata, Viewport } from "next";
import { Toaster } from "sonner";
import { instrument } from "@/lib/fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Onfile: every file signed before work starts", template: "%s | Onfile" },
  description: "Onfile sends your client agreement the moment a file is opened, follows up until it is signed, and keeps a verifiable signed record.",
};

// Server actions that build PDFs or seed a sample workspace get room to finish.
export const maxDuration = 60;

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#f4f6f9" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={instrument.variable}>
      <body>
        {children}
        <Toaster position="top-center" toastOptions={{ style: { fontFamily: "var(--font-sans)", fontSize: 14, borderRadius: 10 } }} />
      </body>
    </html>
  );
}
