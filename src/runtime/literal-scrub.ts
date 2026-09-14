import type { RecordedAction } from "../ir/types.ts";

/**
 * Post-trace scrub for "unstable literal" values that Claude may have baked
 * into recorded actions. These are values whose textual form changes every
 * run (clock readings, Unix-epoch timestamps, ISO datetimes from the page)
 * yet are NOT routed through `${ENV_VAR}` references, so `env-scrub` can't
 * symbolise them. Without this pass they end up in `ir.json`, then in
 * `test.spec.ts`, and the next run fails because the page no longer shows
 * the same literal.
 *
 * The patterns below are intentionally conservative — we accept letting a
 * few real cases through (`mm:ss` price tags, e.g.) rather than dropping
 * assertions the spec author wrote on purpose. Each pattern carries an `id`
 * so the warning log makes it obvious which heuristic fired.
 */
export interface UnstableLiteralHit {
  field: "locator.value" | "locator.name" | "target.value" | "value" | "label" | "observation";
  patternId: string;
  match: string;
}

/**
 * A locator that addresses a password input by construction. The other half
 * of the answer is the `CCQA_SECRET=1` prefix the recorder puts on such a
 * command — a semantic locator (`find label "Password" fill …`) says nothing
 * about the element's type, so the command channel has to.
 */
const PASSWORD_INPUT_SELECTOR = /type\s*=\s*["']?password/i;

/** Whether this action types into a password field, by either signal. */
export function isSecretInput(action: RecordedAction): boolean {
  if (action.action !== "fill" && action.action !== "type") return false;
  if (action.secret === true) return true;
  return action.locator?.by === "css" && PASSWORD_INPUT_SELECTOR.test(action.locator.value);
}

/** What replaces a secret's value once `env-scrub` has symbolised it. */
const SYMBOLISED = /\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/;

export interface UnstableLiteralDrop {
  index: number;
  action: RecordedAction;
  hits: UnstableLiteralHit[];
}

export interface UnstableScrubResult {
  kept: RecordedAction[];
  dropped: UnstableLiteralDrop[];
}

interface UnstablePattern {
  id: string;
  pattern: RegExp;
  label: string;
}

/**
 * Patterns are listed in roughly descending confidence — a hit on `clock-hms`
 * is almost certainly bad; a hit on `unix-epoch-sec` (`1[0-9]{9}`) gates on
 * the value starting with `1`, which empirically rules out most SKU / order-id
 * false positives while still catching epoch seconds in the 2001-2033 window.
 *
 * Relative-time labels ("just now", "N minutes ago", "N分前") are the same
 * class of problem as wall-clock literals: the page shows them, Claude
 * captures them, and they're stale before the test ever replays. We only
 * catch the unambiguous variants — bare "now" or "minute" would false-fire
 * on routine UI copy.
 */
const UNSTABLE_PATTERNS: ReadonlyArray<UnstablePattern> = [
  { id: "clock-hms", pattern: /\b\d{2}:\d{2}:\d{2}\b/, label: "clock time HH:MM:SS" },
  { id: "iso-datetime", pattern: /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, label: "ISO datetime" },
  { id: "iso-date", pattern: /\b\d{4}-\d{2}-\d{2}\b/, label: "ISO date YYYY-MM-DD" },
  { id: "unix-epoch-sec", pattern: /\b1[0-9]{9}\b/, label: "Unix epoch seconds" },
  { id: "unix-epoch-ms", pattern: /\b1[0-9]{12}\b/, label: "Unix epoch milliseconds" },
  // English relative-time phrases. The trailing "ago" anchor keeps us off
  // legitimate duration mentions like "5 minutes" (without "ago").
  {
    id: "relative-time-en",
    pattern: /\b\d+\s+(second|minute|hour|day|week|month|year)s?\s+ago\b/i,
    label: "English relative time (`N <unit> ago`)",
  },
  {
    id: "relative-now-en",
    pattern: /\bjust\s+now\b/i,
    label: "English `just now`",
  },
  // Japanese relative-time phrases. "前" alone is far too generic, so we
  // require a digit + duration unit immediately before it.
  {
    id: "relative-time-ja",
    pattern: /\d+\s*(秒|分|時間|日|週間|か月|ヶ月|年)前/,
    label: "Japanese relative time (`N<unit>前`)",
  },
  {
    id: "relative-now-ja",
    pattern: /たった今/,
    label: "Japanese `たった今`",
  },
  // Japanese calendar dates. The full "2026年5月20日" form is unambiguous;
  // the bare "5月20日" form needs guards so we don't false-fire on:
  //   - the day part of "2026年5月20日" (use lookbehind to skip when "年"
  //     is immediately before the month)
  //   - duration / ordinal phrases like "5日間" / "30日目" (lookahead to
  //     exclude the trailing "間" / "目")
  // We deliberately do NOT match bare "N月" (too many UI labels mention
  // months without a date — "5月の予算", "5月頭" etc).
  {
    id: "ja-date-full",
    pattern: /\d{4}年\d{1,2}月\d{1,2}日/,
    label: "Japanese date YYYY年M月D日",
  },
  {
    id: "ja-date-md",
    pattern: /(?<!年)(?<!\d)\d{1,2}月\d{1,2}日(?![間目])/,
    label: "Japanese date M月D日",
  },
];

/**
 * Opaque machine-generated id shapes. Only the unambiguous forms are listed:
 * long digit or hex runs also appear in addresses a step legitimately names
 * (a date path, a numeric tenant id, a content hash), and a false hit here
 * dead-ends that step — the guard in `claude/invoke.ts` blocks the `open`
 * and the navigate check below drops the action. A missed id still fails
 * verification at record time, so the trade is deliberate.
 *
 * Boundaries are alphanumeric lookarounds, not `\b`, so `item_01H8…`
 * (word-char `_`) is still caught; `i` accepts lowercase ULIDs (a 26-letter
 * lowercase run inside a URL is rare enough to risk). Ids that come from
 * `${ENV_VAR}` values are symbolised before either check runs, never match.
 */
const OPAQUE_ID_PATTERNS: ReadonlyArray<UnstablePattern> = [
  {
    id: "ulid",
    pattern: /(?<![0-9A-Za-z])[0-9A-HJKMNP-TV-Z]{26}(?![0-9A-Za-z])/i,
    label: "ULID",
  },
  {
    id: "uuid",
    pattern: /(?<![0-9A-Za-z])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9A-Za-z])/i,
    label: "UUID",
  },
];

/** First opaque-id hit in `text`, or null. Also used by the `open` guard in `claude/invoke.ts`. */
export function findOpaqueIdSegment(text: string): { patternId: string; match: string } | null {
  for (const p of OPAQUE_ID_PATTERNS) {
    const m = text.match(p.pattern);
    if (m) return { patternId: p.id, match: m[0] };
  }
  return null;
}

/**
 * Inspect a single action and return every (field, pattern) pair that
 * fired. An empty array means the action is safe to keep.
 */
/**
 * Every string an action carries that a value could have been baked into,
 * paired with the field it came from.
 *
 * The one enumeration, because two of them drift: this list is what the
 * unstable-literal scrub reads, and it is also what `env-scrub` asks a saved
 * recording about — a field added to the IR and missed by one of them is a
 * credential nothing looks for.
 */
export function actionLiteralFields(
  action: RecordedAction,
): Array<[UnstableLiteralHit["field"], string]> {
  const fields: Array<[UnstableLiteralHit["field"], string | undefined]> = [
    ["locator.value", action.locator?.value],
    ["locator.name", action.locator?.by === "role" ? action.locator.name : undefined],
    ["target.value", action.target?.value],
    ["value", action.value],
    ["label", action.label],
    ["observation", action.observation],
    ...(action.files ?? []).map((f): [UnstableLiteralHit["field"], string] => ["value", f]),
  ];
  return fields.filter((entry): entry is [UnstableLiteralHit["field"], string] =>
    typeof entry[1] === "string" && entry[1].length > 0,
  );
}

export function detectUnstableLiterals(action: RecordedAction): UnstableLiteralHit[] {
  // A credential still in its own form was never routed through a variable, so
  // there is nothing to symbolise it into and keeping the action would write a
  // password to a file the consumer commits.
  if (isSecretInput(action) && typeof action.value === "string" && !SYMBOLISED.test(action.value)) {
    return [{ field: "value", patternId: "unrouted-secret", match: "(not shown)" }];
  }
  const hits: UnstableLiteralHit[] = [];
  // A navigate to an address carrying an opaque machine-generated id was
  // produced by the run itself; replaying it opens a record later runs do
  // not have. Scoped to navigate: the same id inside a fill or assert may
  // be text the spec legitimately works with.
  if (action.action === "navigate" && typeof action.value === "string") {
    const opaque = findOpaqueIdSegment(action.value);
    if (opaque) hits.push({ field: "value", ...opaque });
  }
  for (const [field, raw] of actionLiteralFields(action)) {
    for (const p of UNSTABLE_PATTERNS) {
      const m = raw.match(p.pattern);
      if (m) hits.push({ field, patternId: p.id, match: m[0] });
    }
  }
  return hits;
}

/**
 * Walk every recorded action and split it into kept / dropped buckets. A
 * `snapshot` action is treated specially: its `observation` field is just a
 * comment in the generated script, so we keep the action even if its
 * `observation` carries an unstable literal — the comment will be wrong but
 * the script will still run. All other actions get dropped on any hit
 * because their locator / `value` would otherwise drive an unreproducible
 * interaction.
 */
export function scrubUnstableActions(actions: RecordedAction[]): UnstableScrubResult {
  const kept: RecordedAction[] = [];
  const dropped: UnstableLiteralDrop[] = [];

  for (let i = 0; i < actions.length; i++) {
    const action = actions[i]!;
    const hits = detectUnstableLiterals(action);
    if (hits.length === 0) {
      kept.push(action);
      continue;
    }
    if (action.action === "snapshot" && hits.every((h) => h.field === "observation")) {
      // Observation-only hit on a snapshot — cosmetic, keep the action.
      kept.push(action);
      continue;
    }
    dropped.push({ index: i, action, hits });
  }

  return { kept, dropped };
}

/**
 * Human-readable summary of one drop, suitable for `log.warn`. The format
 * mirrors `replay-validate`'s drop line so both sources of warnings look
 * uniform in the trace output.
 */
export function formatUnstableDrop(drop: UnstableLiteralDrop): string {
  const { action, hits } = drop;
  if (hits.some((h) => h.patternId === "unrouted-secret")) {
    return (
      "fill into a password field: the value was typed literally, not read from a variable — " +
      "put it in a file named by `envFiles` (or a hub profile) and record again"
    );
  }
  const ids = [...new Set(hits.map((h) => h.patternId))].join(", ");
  const samples = hits.map((h) => `${h.field}="${h.match}"`).join(", ");
  const tag = `${action.action}${action.assert ? " " + action.assert : ""}`;
  return `${tag}: contains unstable literal (${ids}) — ${samples}`;
}
