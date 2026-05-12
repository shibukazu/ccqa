import { z } from "zod";

export const TestStepSchema = z.object({
  id: z.string(),
  title: z.string(),
  instruction: z.string(),
  expected: z.string(),
});
export type TestStep = z.infer<typeof TestStepSchema>;

export const SetupRefSchema = z.object({
  name: z.string(),
  params: z.record(z.string(), z.string()).optional(),
});
export type SetupRef = z.infer<typeof SetupRefSchema>;

export const TestSpecSchema = z.object({
  title: z.string(),
  baseUrl: z.string(),
  prerequisites: z.string().optional(),
  setups: z.array(SetupRefSchema).optional(),
  steps: z.array(TestStepSchema),
});
export type TestSpec = z.infer<typeof TestSpecSchema>;

export const PlaceholderDefSchema = z.object({
  dummy: z.string(),
  description: z.string().optional(),
});

export const SetupSpecSchema = z.object({
  title: z.string(),
  placeholders: z.record(z.string(), PlaceholderDefSchema).optional(),
  steps: z.array(TestStepSchema),
});
export type SetupSpec = z.infer<typeof SetupSpecSchema>;

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
  | "assert";

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
  observation?: string;
  /** Only for command: "assert" */
  assertType?: AssertType;
}

export const DraftIssueSchema = z.object({
  severity: z.enum(["OK", "WARN", "ERROR"]),
  category: z.enum(["assertable", "setups", "granularity", "unimplemented"]),
  stepId: z.string().nullable(),
  message: z.string(),
  detail: z.string().optional(),
});
export type DraftIssue = z.infer<typeof DraftIssueSchema>;

export const DraftReportSchema = z.object({
  issues: z.array(DraftIssueSchema),
  patch: z.string(),
});
export type DraftReport = z.infer<typeof DraftReportSchema>;

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
