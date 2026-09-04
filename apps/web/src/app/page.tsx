import { Fragment } from "react";
import Link from "next/link";
import { cellVars, cls } from "@/lib/ui";

/** One row of the framed preview: a question and how two configs did on it. */
const PREVIEW_ROWS = [
  { question: "What does the document state about the Voyager 1 probe?", wide: "hit", narrow: "miss" },
  { question: "What does the document state about deep-sea anglerfish?", wide: "hit", narrow: "hit" },
  { question: "What does the document state about opportunity zones?", wide: "hit", narrow: "hit" },
] as const;

/**
 * The landing page. It shows the instrument rather than describing it: the preview below the pitch
 * is the run grid's own markup and tokens at rest, so what a visitor sees here is exactly what they
 * get after signing in. Static by construction -- no data, no links out of the tiles.
 */
export default function Home() {
  return (
    <main className={cls.landing}>
      <div className={cls.landingInner}>
        <Link href="/" className={cls.authBrand}>
          <span className={cls.brandMark} aria-hidden="true">
            [
          </span>
          RAGBench
        </Link>

        <h1>Which part of your RAG pipeline lost the answer?</h1>
        <p className={cls.landingPitch}>
          Run one test set against several retrieval configs side by side, then diagnose every miss
          down to chunking, embedding, retrieval depth, or a question the corpus never answered.
        </p>

        <div className={cls.landingCta}>
          <Link href="/login" className={cls.btnPrimary}>
            Log in
          </Link>
          <Link href="/signup" className={cls.btn}>
            Create an account
          </Link>
        </div>

        <div className={cls.preview} aria-hidden="true">
          <div className={cls.previewBar}>
            <span className={cls.brandMark}>[</span>
            Run · 5 questions · 2 configs
          </div>
          <div className={cls.previewGrid}>
            <span className={cls.previewCol} />
            <span className={cls.previewCol}>fixed · k5</span>
            <span className={cls.previewCol}>fixed · k1</span>
            {PREVIEW_ROWS.map((row) => (
              <Fragment key={row.question}>
                <span className={cls.previewQuestion}>{row.question}</span>
                <span className={cls.cell} style={cellVars("success")}>
                  {row.wide}
                </span>
                <span
                  className={cls.cell}
                  style={cellVars(row.narrow === "hit" ? "success" : "danger")}
                >
                  {row.narrow}
                </span>
              </Fragment>
            ))}
          </div>
        </div>

        <p className={cls.landingFoot}>
          Open source. Bring your own keys, or run the whole pipeline on the built-in mock providers
          for nothing.
        </p>
      </div>
    </main>
  );
}
