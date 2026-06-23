import { z } from "zod";

export {
  ActionStepSchema,
  BlockParamSchema,
  BlockSpecSchema,
  IncludeStepSchema,
  StepSchema,
  TestSpecSchema,
  isIncludeStep,
  isParamRequired,
  type ActionStep,
  type BlockParam,
  type BlockSpec,
  type IncludeStep,
  type Step,
  type TestSpec,
} from "./spec/yaml-schema.ts";

export {
  PerspectiveFeatureSchema,
  PerspectiveSpecSchema,
  PerspectiveStatusSchema,
  PerspectivesSchema,
  type PerspectiveFeature,
  type PerspectiveSpec,
  type PerspectiveStatus,
  type Perspectives,
} from "./spec/perspectives-schema.ts";

export const RouteStepSchema = z.object({
  title: z.string(),
  action: z.string(),
  observation: z.string(),
  status: z.enum(["PASSED", "FAILED", "SKIPPED"]),
  reason: z.string().optional(),
});
export type RouteStep = z.infer<typeof RouteStepSchema>;

export const RouteSchema = z.object({
  specName: z.string(),
  timestamp: z.string(),
  status: z.enum(["passed", "failed"]),
  steps: z.array(RouteStepSchema),
});
export type Route = z.infer<typeof RouteSchema>;


export type TraceCommand =
  | "cookies_clear"
  | "open" | "click" | "dblclick" | "fill" | "type"
  | "check" | "uncheck" | "press" | "select"
  | "hover" | "scroll" | "drag" | "wait" | "snapshot"
  | "upload"
  | "assert"
  | "find_click" | "find_dblclick" | "find_fill" | "find_type"
  | "find_hover" | "find_focus" | "find_check" | "find_uncheck";

/**
 * Semantic locator strategies exposed by `agent-browser find`. Used by the
 * `find_*` commands when a target cannot be uniquely picked out by the
 * ALLOWED CSS forms (e.g. repeated `aria-label='1 reply'` rows where only
 * "the last one" is meaningful).
 *
 * `first` / `last` / `nth` are positional helpers and their `findValue`
 * carries an inner CSS selector; `nth` additionally needs `findIndex`. The
 * remaining locators read `findValue` as the human-visible text/id.
 * `role` may pair with `findName` to filter by accessible name.
 */
export const FIND_LOCATORS = [
  "role", "text", "label", "placeholder", "alt", "title", "testid",
  "first", "last", "nth",
] as const;
export type FindLocator = (typeof FIND_LOCATORS)[number];

/**
 * Actions reachable via `agent-browser find <locator> ... <action>`. Kept
 * here next to the locator list so all `find_*` knowledge lives in one
 * place — `cli/trace.ts`, `claude/invoke.ts`, and `runtime/replay-validate.ts`
 * import these instead of redefining their own sets.
 */
export const FIND_ACTIONS = [
  "click", "dblclick", "fill", "type", "hover", "focus", "check", "uncheck",
] as const;
export type FindAction = (typeof FIND_ACTIONS)[number];

export type AssertType =
  | "text_visible" | "text_not_visible"
  | "element_visible" | "element_not_visible"
  | "url_contains"
  | "element_enabled" | "element_disabled"
  | "element_checked" | "element_unchecked";

export interface TraceAction {
  command: TraceCommand;
  selector?: string;
  label?: string;
  value?: string;
  /** For drag: destination selector */
  target?: string;
  /** For scroll: direction (up/down/left/right) and optional pixels */
  direction?: string;
  pixels?: string;
  /**
   * For command: "upload". One or more file paths handed to
   * `agent-browser upload <selector> <files...>`. Each entry may contain
   * `${ENV_VAR}` / `$VAR` references (resolved at run time the same way fill
   * values are) so fixtures can be located via `${CCQA_FIXTURES_DIR}` and
   * survive moves between machines / CI.
   */
  files?: string[];
  observation?: string;
  /** Only for command: "assert" */
  assertType?: AssertType;
  /**
   * Only for command: "find_*". `findValue` holds the locator argument —
   * for `text`/`label`/`placeholder`/`alt`/`title`/`testid` it is the
   * human-visible string; for `first`/`last`/`nth` it is the inner CSS
   * selector.
   */
  findLocator?: FindLocator;
  findValue?: string;
  /** `find role` --name filter. */
  findName?: string;
  /** `find nth` index (0-based). */
  findIndex?: number;
  /** `--exact` flag for text-like locators. */
  findExact?: boolean;
  stepId?: string;
  /**
   * Set by the lenient post-trace validator when this action failed to
   * replay on a fresh session but is still kept in actions.json (and
   * therefore in the generated test). Codegen emits a `// [warn]
   * replay-unstable: <reason>` comment on the preceding line so the auto-fix
   * loop and human reviewers can spot the at-risk action.
   */
  replayUnstable?: boolean;
  replayReason?: string;
}

export const DraftIssueSchema = z.object({
  severity: z.enum(["OK", "WARN", "ERROR"]),
  category: z.enum(["assertable", "blocks", "granularity", "unimplemented"]),
  stepId: z.string().nullable(),
  message: z.string(),
  // Claude sometimes emits an explicit `null` here instead of omitting the
  // key; accept both (nullish) so a well-formed report isn't rejected over a
  // missing optional detail. Every consumer guards with `if (issue.detail)`.
  detail: z.string().nullish(),
});
export type DraftIssue = z.infer<typeof DraftIssueSchema>;

export const DraftReportSchema = z.object({
  issues: z.array(DraftIssueSchema),
  patch: z.string(),
});
export type DraftReport = z.infer<typeof DraftReportSchema>;

export const DRAFT_CATEGORY_LABEL: Record<DraftIssue["category"], string> = {
  assertable: "Assertability",
  blocks: "Block references",
  granularity: "Step granularity",
  unimplemented: "Unimplemented checks",
};

export const DraftNamingSchema = z.object({
  featureName: z.string().min(1),
  specName: z.string().min(1),
  reason: z.string().optional(),
});
export type DraftNaming = z.infer<typeof DraftNamingSchema>;

export type StepStatus = "STEP_START" | "STEP_DONE" | "ASSERTION_FAILED" | "STEP_SKIPPED" | "RUN_COMPLETED";

export interface ParsedStatusLine {
  type: StepStatus;
  stepId: string;
  detail: string;
}
