/**
 * The longest time a step's own text allows, in ms ("within 40 seconds",
 * "up to 2 minutes", "30秒以内"), or undefined when it names none.
 *
 * Read from the case every time rather than stored in the recording: the case
 * is what states it, and a recording that kept a copy would go stale the
 * moment someone edited the step. A false hit costs only a later failure,
 * never a slower pass — it raises a ceiling, it adds no wait.
 */
export function stepTimeLimitMs(text: string): number | undefined {
  let max: number | undefined;
  for (const m of text.normalize("NFKC").matchAll(DURATION)) {
    const minutes = Number(m[1] ?? m[3] ?? 0);
    const seconds = Number(m[2] ?? m[4] ?? m[5] ?? 0);
    const ms = Math.round((minutes * 60 + seconds) * 1000);
    if (ms > 0 && (max === undefined || ms > max)) max = ms;
  }
  return max;
}

const NUM = String.raw`(\d+(?:\.\d+)?)`;
/**
 * `3分の1` is a fraction and `2分割` a split, not a duration; the kanji after
 * `分` that make those words are excluded, while `分以内` / `分間` stay in.
 * English needs a word boundary on both sides so `v2s` or `30sec2` do not read
 * as seconds.
 */
const DURATION = new RegExp(
  [
    String.raw`${NUM}\s*分(?![の割類野析岐担散布離解配母子数])(?:\s*${NUM}\s*秒)?`,
    String.raw`(?<![\w.])${NUM}\s*(?:minutes?|mins?)\b(?:\s*(?:and\s*)?${NUM}\s*(?:seconds?|secs?|s)\b)?`,
    String.raw`(?<![\w.])${NUM}\s*(?:(?:seconds?|secs?|s)\b|秒)`,
  ].join("|"),
  "gi",
);

/** stepId → the step's limit, for the steps whose instruction or expected names one. */
export function stepTimeLimits(
  steps: readonly { id: string; instruction?: string; expected?: string }[],
): Map<string, number> {
  const limits = new Map<string, number>();
  for (const step of steps) {
    const ms = stepTimeLimitMs(`${step.instruction ?? ""}\n${step.expected ?? ""}`);
    if (ms !== undefined) limits.set(step.id, ms);
  }
  return limits;
}
