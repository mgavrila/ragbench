import type { CSSProperties, ReactNode } from "react";
import Link from "next/link";
import { signOut } from "@/auth";
import { cls } from "@/lib/ui";

/**
 * The frame every signed-in page renders inside: one 48px bar (wordmark home, sign out) above a
 * centred content column. Deliberately not applied in the root layout -- /login and /signup have
 * no session to sign out of and get the centred-card treatment instead.
 *
 * `wide` raises the content column for the run dashboard, whose question grid gains a column per
 * config and outgrows the reading-width default that every other page wants.
 */
export function AppShell({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  async function doSignOut() {
    "use server";
    await signOut({ redirectTo: "/login" });
  }

  return (
    <div className={cls.shell}>
      <header className="rb-topbar">
        <Link href="/projects" className="rb-topbar__brand">
          <span className="rb-topbar__mark" aria-hidden="true">
            [
          </span>
          RAGBench
        </Link>
        <Link href="/projects" className="rb-topbar__link">
          Projects
        </Link>
        <span className="rb-topbar__spacer" />
        <form action={doSignOut}>
          <button type="submit" className="rb-btn rb-btn--sm">
            Sign out
          </button>
        </form>
      </header>
      <main
        className={cls.main}
        style={wide ? ({ "--rb-measure": "1440px" } as CSSProperties) : undefined}
      >
        {children}
      </main>
    </div>
  );
}
