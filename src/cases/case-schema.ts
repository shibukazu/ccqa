import { z } from "zod";
import type { Case } from "./contract.ts";

/**
 * The published contract, as something ccqa can check an answer against.
 *
 * Internal on purpose: `ccqa/case-source` exports types only, so a reader
 * module never has to resolve ccqa's zod. The two are kept in step by the
 * assertions below rather than by one being derived from the other — the
 * public shape stays hand-written and readable, and a field added to either
 * without the other stops the build.
 */
const CaseStepSchema = z
  .object({
    instruction: z.string().min(1),
    expected: z.string().optional(),
  })
  .strict();

export const CaseSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .regex(
        /^[^/\\][^\\]*$/,
        "a case id is a '/'-separated path with no leading slash and no backslashes",
      )
      .refine((id) => !id.endsWith("/") && !id.split("/").includes(".."), {
        message: "a case id must not end in '/' or contain '..'",
      }),
    path: z.string().min(1),
    text: z.string(),
    title: z.string().min(1),
    mode: z.enum(["deterministic", "live"]),
    steps: z.array(CaseStepSchema).min(1),
    cleanup: z.array(CaseStepSchema).optional(),
    expectations: z.array(z.string().min(1)).optional(),
    cleanupExpectations: z.array(z.string().min(1)).optional(),
    context: z
      .array(z.object({ heading: z.string().min(1), body: z.string() }).strict())
      .optional(),
    fields: z.record(z.string().min(1), z.string()).optional(),
    disabled: z.boolean().optional(),
  })
  .strict();

/** Fails the build when the schema and the published shape drift apart. */
type AssertAssignable<A extends B, B> = [A, B];
type _SchemaAnswersContract = AssertAssignable<z.infer<typeof CaseSchema>, Case>;
type _ContractIsAccepted = AssertAssignable<Case, z.infer<typeof CaseSchema>>;
