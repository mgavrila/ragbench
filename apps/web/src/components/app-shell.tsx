import type { CSSProperties, ReactNode } from "react";
import Link from "next/link";
import { auth, signOut } from "@/auth";
import { cls, cx } from "@/lib/ui";

/** One link in the rail. `href` may be a route or an in-page anchor. */
export type NavItem = { href: string; label: string };

/**
 * The context group a page contributes to the rail: what is being looked at, and the places to go
 * from inside it. Optional -- /projects is its own context and passes none.
 */
export type NavContext = { label: string; subject: string; items: NavItem[] };

/**
 * The frame every signed-in page renders inside: a full-height navigation rail beside a content
 * well. Deliberately not applied in the root layout -- /login and /signup have no session to sign
 * out of and get the centred-card treatment instead.
 *
 * The rail is a grid COLUMN rather than a fixed or sticky element, so its surface runs the whole
 * height of a long page (and of a full-page screenshot of one); the panel inside it is what
 * actually sticks to the viewport. See `.rb-shell` in globals.css.
 *
 * `wide` raises the content column for the run dashboard, whose question grid gains a column per
 * config and outgrows the reading-width default that every other page wants.
 */
export async function AppShell({
  children,
  wide = false,
  context,
  crumbs = [],
}: {
  children: ReactNode;
  wide?: boolean;
  context?: NavContext;
  /** The trail in the topbar. The LAST entry is the current page and renders as text, not a link. */
  crumbs?: NavItem[];
}) {
  async function doSignOut() {
    "use server";
    await signOut({ redirectTo: "/login" });
  }

  // Every page that renders the shell has already established a session; this read is for the
  // account chip's label only, and degrades to the chip's initial if it is somehow absent.
  const session = await auth();
  const email = session?.user?.email ?? "";

  return (
    <div className={cls.shell}>
      <aside className="rb-sidebar">
        <div className="rb-sidebar__inner">
          <div className="rb-sidebar__brand-row">
            <Link href="/projects" className={cls.brand}>
              <span className={cls.brandMark} aria-hidden="true">
                [
              </span>
              RAGBench
            </Link>
          </div>

          <div className="rb-sidebar__nav">
            <nav className="rb-nav" aria-label="Primary">
              <p className="rb-nav__label">Workspace</p>
              <Link
                href="/projects"
                className={cx("rb-nav__item", !context && "rb-nav__item--active")}
              >
                Projects
              </Link>
            </nav>

            {context ? (
              <nav className="rb-nav" aria-label={context.label}>
                <p className="rb-nav__label">{context.label}</p>
                <span className="rb-nav__subject" title={context.subject}>
                  {context.subject}
                </span>
                {context.items.map((item) => (
                  <Link key={item.href} href={item.href} className="rb-nav__item">
                    {item.label}
                  </Link>
                ))}
              </nav>
            ) : null}
          </div>

          <div className="rb-sidebar__foot">
            <div className="rb-account">
              <span className="rb-account__avatar" aria-hidden="true">
                {email.slice(0, 1) || "·"}
              </span>
              <span className="rb-account__name" title={email}>
                {email}
              </span>
            </div>
            <form action={doSignOut}>
              <button type="submit" className="rb-btn rb-btn--sm rb-btn--block">
                Sign out
              </button>
            </form>
          </div>
        </div>
      </aside>

      <div className="rb-viewport">
        {crumbs.length > 0 ? (
          <header className="rb-topbar">
            <nav className="rb-crumbs" aria-label="Breadcrumb">
              <ol>
                {crumbs.map((crumb, i) =>
                  i === crumbs.length - 1 ? (
                    <li key={crumb.href}>
                      <span className="rb-crumbs__current" aria-current="page" title={crumb.label}>
                        {crumb.label}
                      </span>
                    </li>
                  ) : (
                    <li key={crumb.href}>
                      <Link href={crumb.href}>{crumb.label}</Link>
                    </li>
                  ),
                )}
              </ol>
            </nav>
          </header>
        ) : null}
        <main
          className={cls.main}
          style={wide ? ({ "--rb-measure": "1440px" } as CSSProperties) : undefined}
        >
          {children}
        </main>
      </div>
    </div>
  );
}
