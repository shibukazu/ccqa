import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import {
  DriftLabelSchema,
  DriftSubDiagnosisSchema,
  DriftSurfaceSchema,
  SpecChangeKindSchema,
} from "../../src/report/schema.ts";
import { SelectVerdictSchema } from "../../src/select/types.ts";
import { listAllSpecsWithSpecFile, specKey } from "../../src/store/index.ts";

/**
 * One declared change to the baseline app: either a search/replace pair or a
 * file deletion. Search/replace over unified diffs on purpose — a diff's
 * context lines rot silently when the baseline moves, while a search string
 * that no longer matches fails the run loudly (see `applyMutations`).
 */
export const MutationSchema = z.union([
  z
    .object({
      file: z.string().min(1),
      search: z.string().min(1),
      replace: z.string(),
    })
    .strict(),
  z
    .object({
      file: z.string().min(1),
      delete: z.literal(true),
    })
    .strict(),
]);
export type Mutation = z.infer<typeof MutationSchema>;

/**
 * What the audit must answer for one spec. Specs absent from the map are
 * expected clean, so a case only names its casualties. `surface` /
 * `subDiagnosis` / `specChangeKind` are scored as sub-answers when declared,
 * and only among label-correct predictions — a wrong label already counts
 * against the case, and its sub-fields answer a question that was not asked.
 *
 * The vocabulary is the audit's own (`src/report/schema.ts`), narrowed:
 * `UNKNOWN` is not a ground truth a case may declare, and the sub-answer
 * values that are also `DriftDiagnosisSchema` defaults (`surface: spec`,
 * `subDiagnosis: NONE`) are rejected — the CLI's JSON is post-parse, so a
 * defaulted field cannot be told apart from a model that answered, and an
 * expectation that cannot lose must not be scored.
 */
export const AuditExpectationSchema = z
  .object({
    label: DriftLabelSchema.exclude(["UNKNOWN"]),
    surface: DriftSurfaceSchema.exclude(["spec"]).optional(),
    subDiagnosis: DriftSubDiagnosisSchema.exclude(["NONE"]).optional(),
    specChangeKind: SpecChangeKindSchema.optional(),
  })
  .strict();
export type AuditExpectation = z.infer<typeof AuditExpectationSchema>;

/** `unknown` is the model's fallback, never a ground truth a case may declare. */
export const SelectExpectationSchema = SelectVerdictSchema.exclude(["unknown"]);
export type SelectExpectation = z.infer<typeof SelectExpectationSchema>;

export const EvalCaseSchema = z
  .object({
    title: z.string().min(1),
    mutations: z.array(MutationSchema).default([]),
    expect: z
      .object({
        audit: z.record(z.string(), AuditExpectationSchema).optional(),
        select: z.record(z.string(), SelectExpectationSchema).optional(),
      })
      .strict(),
  })
  .strict();

export interface EvalCase extends z.infer<typeof EvalCaseSchema> {
  /** The case file's basename without extension; what a CLI filter matches. */
  name: string;
}

/** Spec keys (`feature/spec`) present in the baseline app's `.ccqa` tree. */
export async function listFixtureSpecKeys(appDir: string): Promise<string[]> {
  const refs = await listAllSpecsWithSpecFile(appDir);
  return refs.map(specKey).sort();
}

/**
 * Load every case under `casesDir`, validated against the fixture's spec
 * keys. A typo in an expectation key would otherwise score as "the model
 * missed this spec" — the harness fails instead of measuring a phantom.
 */
export async function loadCases(casesDir: string, specKeys: readonly string[]): Promise<EvalCase[]> {
  const known = new Set(specKeys);
  const files = (await readdir(casesDir)).filter((f) => f.endsWith(".yaml")).sort();
  return Promise.all(
    files.map(async (file) => {
      const name = basename(file, ".yaml");
      const parsed = EvalCaseSchema.safeParse(parse(await readFile(join(casesDir, file), "utf8")));
      if (!parsed.success) {
        throw new Error(`invalid case file ${file}: ${parsed.error.message}`);
      }
      for (const key of [
        ...Object.keys(parsed.data.expect.audit ?? {}),
        ...Object.keys(parsed.data.expect.select ?? {}),
      ]) {
        if (!known.has(key)) {
          throw new Error(`case ${name} expects a verdict for unknown spec "${key}" (known: ${specKeys.join(", ")})`);
        }
      }
      return { name, ...parsed.data };
    }),
  );
}

export function filterCases(cases: EvalCase[], kind: "audit" | "select", filter?: string): EvalCase[] {
  const withKind = cases.filter((c) => c.expect[kind] !== undefined);
  const filtered = filter ? withKind.filter((c) => c.name.includes(filter)) : withKind;
  if (filtered.length === 0) {
    throw new Error(filter ? `no ${kind} case matches "${filter}"` : `no ${kind} cases found`);
  }
  return filtered;
}
