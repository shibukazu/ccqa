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

export {
  type AssertType,
  type Locator,
  type LocatorIndex,
  type RecordedAction,
} from "./ir/types.ts";

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
