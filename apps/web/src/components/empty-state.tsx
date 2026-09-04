import type { ReactNode } from "react";
import { cls } from "@/lib/ui";

/**
 * What a list shows before it has anything in it. Always says what the next action is: an empty
 * table with only column headers tells the user nothing about how to fill it.
 *
 * The glyph is an empty three-row table drawn in one 20px SVG -- the shape of the thing that is
 * missing, at hairline weight, rather than an illustration. Decorative, so it is hidden from the
 * accessibility tree and the title carries the meaning on its own.
 */
export function EmptyState({ title, hint }: { title: string; hint?: ReactNode }) {
  return (
    <div className={cls.empty}>
      <svg
        className="rb-empty__glyph"
        width="21"
        height="18"
        viewBox="0 0 26 22"
        fill="none"
        aria-hidden="true"
        focusable="false"
      >
        <rect x="0.75" y="0.75" width="24.5" height="20.5" rx="3.25" stroke="currentColor" strokeWidth="1.5" />
        <path d="M0.75 7.25H25.25" stroke="currentColor" strokeWidth="1.5" />
        <path d="M0.75 14.25H25.25" stroke="currentColor" strokeWidth="1.5" strokeDasharray="3 3" />
        <path d="M9.75 7.25V21.25" stroke="currentColor" strokeWidth="1.5" strokeDasharray="3 3" />
      </svg>
      <div className="rb-empty__title">{title}</div>
      {hint ? <div className="rb-empty__hint">{hint}</div> : null}
    </div>
  );
}
