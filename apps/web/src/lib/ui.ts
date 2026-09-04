import type { CSSProperties } from "react";
import type { AttributionVerdict } from "@ragbench/core";

/**
 * The design system's TypeScript half. Split of responsibility with `app/globals.css`:
 *
 *  - globals.css owns the NEUTRAL palette and every selector-dependent state (hover, focus-visible,
 *    row striping, ::selection) that an inline style object cannot express. Those values are read
 *    from here as `var(--rb-*)` so no neutral is written twice.
 *  - this module owns the four STATE colours, because they are chosen from data at render time
 *    (a status string, a verdict, a hit/miss) and therefore have to reach the DOM as inline styles.
 *
 * Net effect: every colour in the product has exactly one definition. Before this module the four
 * state hexes and the table cell style were copy-pasted into five clients; those copies are gone.
 */

/**
 * The four state colours. Chosen so white text on top of any of them clears 4.5:1, and so each is
 * distinguishable from the others in greyscale by lightness.
 */
export const state = {
  /** Terminal and good: ready, done, hit, a recovered counterfactual. */
  success: "#1a7f37",
  /** In flight, or finished with a caveat: parsing, generating, running, an evaluated-but-failed cell. */
  warning: "#9a6700",
  /** Terminal and bad: failed, miss. */
  danger: "#cf222e",
  /** No signal either way: pending, queued, cancelled, duplicate, unanswerable. */
  neutral: "#57606a",
} as const;

export type Tone = keyof typeof state;

/** Neutrals, as references to the CSS custom properties that define them (see globals.css). */
export const neutral = {
  canvas: "var(--rb-canvas)",
  surface: "var(--rb-surface)",
  surfaceMuted: "var(--rb-surface-muted)",
  border: "var(--rb-border)",
  borderMuted: "var(--rb-border-muted)",
  borderStrong: "var(--rb-border-strong)",
  text: "var(--rb-text)",
  textMuted: "var(--rb-text-muted)",
  textInverse: "var(--rb-text-inverse)",
  accent: "var(--rb-accent)",
} as const;

/** 4px base scale. Every gap, pad and margin in the product is one of these. */
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;

export const radius = { sm: 4, md: 6, lg: 8, pill: 999 } as const;

export const font = {
  sans: "var(--rb-font)",
  mono: "var(--rb-font-mono)",
} as const;

/**
 * Class names from globals.css, as a typed map. Imported rather than typed as string literals at
 * each call site so a renamed class is a compile error in every client at once.
 */
export const cls = {
  main: "rb-main",
  shell: "rb-shell",
  card: "rb-card",
  cardPad: "rb-card rb-card--pad",
  section: "rb-section",
  sectionHead: "rb-section__head",
  sectionHint: "rb-section__hint",
  eyebrow: "rb-eyebrow",
  tableWrap: "rb-table-wrap",
  table: "rb-table",
  num: "rb-num",
  mono: "rb-mono",
  muted: "rb-muted",
  truncate: "rb-truncate",
  btn: "rb-btn",
  btnPrimary: "rb-btn rb-btn--primary",
  btnSm: "rb-btn rb-btn--sm",
  btnGhost: "rb-btn rb-btn--ghost",
  form: "rb-form",
  formStack: "rb-form rb-form--stack",
  field: "rb-field",
  fieldLabel: "rb-field__label",
  input: "rb-input",
  fieldset: "rb-fieldset",
  choice: "rb-choice",
  choiceInline: "rb-choice rb-choice--inline",
  notice: "rb-notice",
  empty: "rb-empty",
  /** Modifier on top of `table`, for the run dashboard's question grid. */
  grid: "rb-grid",
  gridQuestion: "rb-grid__question",
  cell: "rb-cell",
  cellSelected: "rb-cell--selected",
  cellPending: "rb-cell rb-cell--pending",
  drawer: "rb-drawer",
  drawerHead: "rb-drawer__head",
  drawerBlock: "rb-drawer__block",
  doc: "rb-doc",
  tick: "rb-tick",
  legend: "rb-legend",
  legendItem: "rb-legend__item",
  legendSwatch: "rb-legend__swatch",
  kv: "rb-kv",
  progress: "rb-progress",
  stack: "rb-stack",
  row: "rb-row",
  code: "rb-code",
} as const;

/**
 * Status string -> tone, for every status the product has: documents (parsing/ready/failed/
 * duplicate), test sets (generating/ready/failed) and runs (pending/running/done/failed/cancelled).
 * One table for all three, because the same word must not mean two colours in two tables. An
 * unrecognised status falls back to neutral rather than to unstyled text.
 */
const STATUS_TONE: Record<string, Tone> = {
  ready: "success",
  done: "success",
  parsing: "warning",
  generating: "warning",
  running: "warning",
  failed: "danger",
  pending: "neutral",
  queued: "neutral",
  cancelled: "neutral",
  duplicate: "neutral",
};

export function statusTone(status: string): Tone {
  return STATUS_TONE[status] ?? "neutral";
}

export function statusColor(status: string): string {
  return state[statusTone(status)];
}

/**
 * Verdict -> tone, on the axis "how far from a quick fix is this": retrieval is fixable by raising
 * k (success), chunking and embedding both need artifacts rebuilt (warning/danger by how much has
 * to change), and unanswerable is a test-set problem rather than a pipeline failure (neutral).
 * Unchanged from the mapping run-client and evidence-client each carried their own copy of.
 */
export const VERDICT_TONE: Record<AttributionVerdict, Tone> = {
  retrieval: "success",
  chunking: "warning",
  embedding: "danger",
  unanswerable: "neutral",
};

export function verdictColor(verdict: AttributionVerdict): string {
  return state[VERDICT_TONE[verdict]];
}

/**
 * A grid cell's tone. A `failed` cell can still carry a real hit/rr (retrieval succeeded, the
 * answer or judge step failed afterwards), so failure outranks the hit/miss reading: amber.
 */
export function cellTone(cell: { hit: boolean | null; status: string }): Tone {
  if (cell.status === "failed") return "warning";
  if (cell.hit === true) return "success";
  if (cell.hit === false) return "danger";
  return "neutral";
}

/** A solid tone chip: white on the state colour. For headline verdicts, not for table rows. */
export function solidToneStyle(tone: Tone): CSSProperties {
  return {
    display: "inline-block",
    padding: "2px 8px",
    fontSize: 12,
    fontWeight: 600,
    lineHeight: "18px",
    color: neutral.textInverse,
    background: state[tone],
    borderRadius: radius.sm,
  };
}

/** The 6px round status dot that precedes a status word in a table. */
export function dotStyle(tone: Tone): CSSProperties {
  return {
    display: "inline-block",
    flex: "none",
    width: 6,
    height: 6,
    borderRadius: radius.pill,
    background: state[tone],
  };
}

/** Left rule colour for a notice, so an error and an advisory are distinguishable at a glance. */
export function noticeStyle(tone: Tone): CSSProperties {
  return { borderLeftColor: state[tone], color: neutral.text };
}

/** Joins class names, dropping falsy entries. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
