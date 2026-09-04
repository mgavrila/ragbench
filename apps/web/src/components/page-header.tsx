import type { ReactNode } from "react";
import { cls } from "@/lib/ui";

/**
 * Title block for a page: an optional small-caps eyebrow naming the kind of thing being looked at
 * ("PROJECT", "RUN"), the title itself, a meta line for the row of facts that qualifies it, and a
 * right-hand slot for page-level actions.
 */
export function PageHeader({
  eyebrow,
  title,
  meta,
  actions,
}: {
  eyebrow?: string;
  title: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="rb-page-header">
      <div className="rb-page-header__body">
        {eyebrow ? <span className={cls.eyebrow}>{eyebrow}</span> : null}
        <h1>{title}</h1>
        {meta ? <div className="rb-page-header__meta">{meta}</div> : null}
      </div>
      {actions ? <div className={cls.row}>{actions}</div> : null}
    </div>
  );
}

/** Section heading with an optional right-hand hint, used for the blocks inside a page. */
export function SectionHead({ title, hint }: { title: string; hint?: ReactNode }) {
  return (
    <div className={cls.sectionHead}>
      <h2>{title}</h2>
      {hint ? <span className={cls.sectionHint}>{hint}</span> : null}
    </div>
  );
}
