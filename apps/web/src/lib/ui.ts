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
  textSecondary: "var(--rb-text-secondary)",
  textMuted: "var(--rb-text-muted)",
  textSubtle: "var(--rb-text-subtle)",
  textInverse: "var(--rb-text-inverse)",
  accent: "var(--rb-accent)",
} as const;

/**
 * The wash and hairline that go with each state colour, for the surfaces that carry state as a
 * FILL rather than as ink -- a grid tile, a notice. Defined in globals.css (surfaces are its
 * department) and only referenced here, so a tint still has exactly one definition.
 *
 * Why a wash and not the colour itself: each state hex is tuned to clear 4.5:1 under WHITE text,
 * which leaves it at ~4.3-4.5:1 as ink on its own pale tint -- i.e. failing. Filling with the tint
 * and writing the label in --rb-text puts the text at 15:1 and still carries the state three ways
 * over (the fill, the square dot, and the word itself).
 */
export const tint = {
  success: { fill: "var(--rb-tint-success)", line: "var(--rb-line-success)" },
  warning: { fill: "var(--rb-tint-warning)", line: "var(--rb-line-warning)" },
  danger: { fill: "var(--rb-tint-danger)", line: "var(--rb-line-danger)" },
  neutral: { fill: "var(--rb-tint-neutral)", line: "var(--rb-line-neutral)" },
} as const satisfies Record<Tone, { fill: string; line: string }>;

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
  brand: "rb-brand",
  brandMark: "rb-brand__mark",
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
  gridText: "rb-grid__text",
  cell: "rb-cell",
  cellSelected: "rb-cell--selected",
  cellPending: "rb-cell--pending",
  drawer: "rb-drawer",
  drawerHead: "rb-drawer__head",
  drawerBlock: "rb-drawer__block",
  doc: "rb-doc",
  tick: "rb-tick",
  reading: "rb-reading",
  diagnosisHead: "rb-diagnosis__head",
  diagnosisProse: "rb-diagnosis__prose",
  legend: "rb-legend",
  legendItem: "rb-legend__item",
  legendSwatch: "rb-legend__swatch",
  kv: "rb-kv",
  progress: "rb-progress",
  progressLive: "rb-progress--live",
  stack: "rb-stack",
  row: "rb-row",
  code: "rb-code",
  dotSep: "rb-dot-sep",
  landing: "rb-landing",
  landingInner: "rb-landing__inner",
  landingPitch: "rb-landing__pitch",
  landingCta: "rb-landing__cta",
  landingFoot: "rb-landing__foot",
  preview: "rb-preview",
  previewBar: "rb-preview__bar",
  previewGrid: "rb-preview__grid",
  previewQuestion: "rb-preview__q",
  previewCol: "rb-preview__col",
  authBrand: "rb-auth__brand",
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
    padding: "4px 11px",
    fontSize: 13,
    fontWeight: 600,
    lineHeight: "18px",
    letterSpacing: "-0.008em",
    color: neutral.textInverse,
    background: state[tone],
    borderRadius: radius.md,
    boxShadow: "var(--rb-shadow-sm)",
  };
}

/**
 * The three custom properties a run-grid tile is painted from: the wash it fills with, the
 * hairline around it, and the square dot that repeats the state in full strength. Handed to the
 * DOM as inline custom properties rather than as concrete `background`/`border` declarations so
 * that `.rb-cell`'s own hover, focus and selected rules can reach the same three values -- a
 * selector cannot read back an inline `background`, but it can read `var(--rb-cell-dot)`.
 */
export function cellVars(tone: Tone): CSSProperties {
  return {
    "--rb-cell-tint": tint[tone].fill,
    "--rb-cell-line": tint[tone].line,
    "--rb-cell-dot": state[tone],
  } as CSSProperties;
}

/**
 * The 6px status mark that precedes a status word in a table. A rounded square rather than a
 * circle, so it is the same mark the run grid's tiles carry -- one shape means "state" everywhere.
 */
export function dotStyle(tone: Tone): CSSProperties {
  return {
    display: "inline-block",
    flex: "none",
    width: 6,
    height: 6,
    borderRadius: 1.5,
    background: state[tone],
  };
}

/**
 * A notice's state surface: the state colour as its left rule at full strength, its wash behind
 * the text. The text itself stays --rb-text -- a message is read, not scanned, so it gets the
 * 15:1 ink rather than a state hex sitting at ~4.4:1 on its own tint.
 */
export function noticeStyle(tone: Tone): CSSProperties {
  // Order matters: React writes these in key order, so the four-sided `borderColor` has to be set
  // before the left edge is overridden, or it would flatten the state rule back to the hairline.
  return {
    borderColor: tint[tone].line,
    borderLeftColor: state[tone],
    borderLeftWidth: 3,
    background: tint[tone].fill,
    color: neutral.text,
  };
}

/** Joins class names, dropping falsy entries. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
