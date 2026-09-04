import "./globals.css";

export const metadata = {
  title: "RAGBench",
  description: "Find out which part of your RAG pipeline is losing the answer.",
};

/**
 * Deliberately bare: the content column and the nav bar live in `AppShell`, which only the
 * signed-in pages wrap themselves in. /login, /signup and the landing page centre their own card
 * against the canvas instead.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
