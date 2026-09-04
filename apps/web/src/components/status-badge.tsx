import { dotStyle, solidToneStyle, state, statusTone, type Tone } from "@/lib/ui";

/**
 * A status word carrying its state colour. Two variants:
 *
 *  - `dot` (default): a 6px dot plus the word in the state colour, for table rows -- a column of
 *    solid pills fights the row rules, a column of dots reads down the table.
 *  - `solid`: white on the state colour, for the one headline verdict on the evidence page.
 *
 * The dot is never the only carrier of meaning: the word is always there next to it.
 */
export function StatusBadge({
  status,
  tone,
  variant = "dot",
}: {
  status: string;
  /** Overrides the status->tone table, for values that are not statuses (a verdict, a hit/miss). */
  tone?: Tone;
  variant?: "dot" | "solid";
}) {
  const resolved = tone ?? statusTone(status);
  if (variant === "solid") {
    return <span style={solidToneStyle(resolved)}>{status}</span>;
  }
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, whiteSpace: "nowrap" }}>
      <span style={dotStyle(resolved)} aria-hidden="true" />
      <span style={{ color: state[resolved], fontWeight: 500 }}>{status}</span>
    </span>
  );
}
