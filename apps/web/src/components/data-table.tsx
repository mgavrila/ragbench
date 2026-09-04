import type { ReactNode } from "react";
import { cls, cx } from "@/lib/ui";

/**
 * A table in its own bordered card, scrolling horizontally inside that card rather than widening
 * the page. `empty` is rendered in place of the table when there are no rows -- passing it is how
 * a list gets its empty state, so the two cannot drift apart.
 */
export function DataTable({
  head,
  children,
  empty,
  isEmpty = false,
  className,
}: {
  head: ReactNode;
  children: ReactNode;
  empty?: ReactNode;
  isEmpty?: boolean;
  className?: string;
}) {
  if (isEmpty && empty) return <>{empty}</>;
  return (
    <div className={cls.tableWrap}>
      <table className={cx(cls.table, className)}>
        <thead>
          <tr>{head}</tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
