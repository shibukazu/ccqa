/**
 * Tool-neutral intermediate representation (IR) for recorded browser
 * interactions. A trace produces `RecordedAction[]` (persisted as `ir.json`);
 * emitters translate it into target-specific test code and the replay
 * validator re-executes it. The IR replaces the old dual addressing
 * (raw selector strings vs `find_*` + findLocator fields) with a single
 * `Locator` model.
 */

export type AssertType =
  | "text_visible" | "text_not_visible"
  | "element_visible" | "element_not_visible"
  | "url_contains"
  | "element_enabled" | "element_disabled"
  | "element_checked" | "element_unchecked";

/**
 * How an action addresses its target element.
 *
 * - `by: "css"` holds a raw selector-engine string exactly as a plain
 *   agent-browser command accepts it (CSS forms like `[aria-label='...']`,
 *   and the `text=...` engine form). It round-trips verbatim.
 * - The semantic strategies (`text` / `label` / `placeholder` / `alt` /
 *   `title` / `testid` / `role`) correspond to `agent-browser find` locators
 *   (and map 1:1 onto Playwright's getBy* family). `text=...` recorded via
 *   `wait --text` also normalizes to `by: "text"`.
 */
export type Locator =
  | { by: "css"; value: string }
  | { by: "text" | "label" | "placeholder" | "alt" | "title" | "testid";
      value: string; exact?: boolean }
  | { by: "role"; value: string; name?: string; exact?: boolean };

/** Positional pick among multiple locator matches (`find first/last/nth`). */
export type LocatorIndex = "first" | "last" | number;

export interface RecordedAction {
  /**
   * `snapshot` is an observation-only command: it never executes at replay
   * time and codegen renders it as a comment. It stays in the IR so recorded
   * observations survive into the generated test. `focus` is reachable only
   * through the `find` form (agent-browser has no plain `focus` command).
   */
  action:
    | "navigate" | "click" | "dblclick" | "fill" | "type" | "press"
    | "check" | "uncheck" | "select" | "hover" | "focus" | "drag" | "upload"
    | "scroll" | "wait" | "assert" | "snapshot" | "cookies_clear";
  locator?: Locator;
  /** Positional modifier: pick the first/last/nth match of `locator`. */
  index?: LocatorIndex;
  /** Fill/select text, pressed key, opened URL, or assert expectation. */
  value?: string;
  /** For action: "drag" — the destination. */
  target?: Locator;
  /**
   * For action: "upload". One or more file paths handed to
   * `agent-browser upload <selector> <files...>`. Each entry may contain
   * `${ENV_VAR}` / `$VAR` references (resolved at run time the same way fill
   * values are) so fixtures can be located via `${CCQA_FIXTURES_DIR}` and
   * survive moves between machines / CI.
   */
  files?: string[];
  /** Only for action: "assert". */
  assert?: AssertType;
  /** For action: "scroll" — direction (up/down/left/right) and optional pixels. */
  direction?: string;
  pixels?: string;
  /** Human-visible label of the target, kept for logs / summaries / scrubbing. */
  label?: string;
  observation?: string;
  /** Spec step this action belongs to (from the last STEP_START line). */
  stepId?: string;
  /**
   * Set by the lenient post-trace validator when this action failed to
   * replay on a fresh session but is still kept in ir.json (and therefore
   * in the generated test). Codegen emits a `// [warn] replay-unstable:
   * <reason>` comment on the preceding line so the auto-fix loop and human
   * reviewers can spot the at-risk action.
   */
  replayUnstable?: boolean;
  replayReason?: string;
}
