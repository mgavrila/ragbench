import type { ReactNode } from "react";
import { cls } from "@/lib/ui";

/**
 * What a list shows before it has anything in it. Always says what the next action is: an empty
 * table with only column headers tells the user nothing about how to fill it.
 */
export function EmptyState({ title, hint }: { title: string; hint?: ReactNode }) {
  return (
    <div className={cls.empty}>
      <div className="rb-empty__title">{title}</div>
      {hint ? <div className="rb-empty__hint">{hint}</div> : null}
    </div>
  );
}
