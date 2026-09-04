import { Geist } from "next/font/google";
import "./globals.css";

/**
 * The product's one UI face, self-hosted by next/font at build time -- no runtime request to a
 * font CDN, and no layout shift while it loads. Exposed as a custom property rather than as a
 * class on <body> so globals.css can name it in the same `--rb-font` stack every other rule reads,
 * with system-ui behind it if the file ever fails to load. Identifiers and figures keep the
 * platform mono stack (see --rb-font-mono); there is no second display face.
 */
const geist = Geist({
  subsets: ["latin"],
  display: "swap",
  variable: "--rb-font-sans",
});

export const metadata = {
  title: "RAGBench",
  description: "Find out which part of your RAG pipeline is losing the answer.",
};

/**
 * Deliberately bare: the content column and the navigation rail live in `AppShell`, which only the
 * signed-in pages wrap themselves in. /login, /signup and the landing page centre their own card
 * against the canvas instead.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={geist.variable}>
      <body>{children}</body>
    </html>
  );
}
