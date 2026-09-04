import type { ReactNode } from "react";
import { cls, noticeStyle, type Tone } from "@/lib/ui";

/**
 * An inline message with a state-coloured left rule. `role` is explicit rather than derived from
 * the tone: an error a user caused is an `alert` (announced immediately), whereas a degraded-poll
 * banner over data that is merely stale is a `status` (announced politely, not interrupting).
 */
export function Notice({
  tone = "danger",
  role = "alert",
  children,
}: {
  tone?: Tone;
  role?: "alert" | "status";
  children: ReactNode;
}) {
  return (
    <p className={cls.notice} style={noticeStyle(tone)} role={role}>
      {children}
    </p>
  );
}
