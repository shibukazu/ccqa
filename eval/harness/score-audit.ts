import { z } from "zod";
import type { AuditExpectation } from "./cases.ts";

/**
 * What one `ccqa audit --report-format json` sweep printed. Parsed leniently
 * (unknown keys stripped, drift fields optional) so a report-shape addition
 * upstream does not break the harness; the fields scored here are the ones
 * the contract already guarantees.
 */
export const AuditOutputSchema = z.object({
  specs: z.array(
    z.object({
      feature: z.string(),
      spec: z.string(),
      ok: z.boolean(),
      error: z.string().optional(),
      drift: z
        .object({
          label: z.string(),
          surface: z.string().optional(),
          subDiagnosis: z.string().optional(),
          specChangeKind: z.string().optional(),
          headline: z.string().optional(),
          confidence: z.number().optional(),
        })
        .nullable(),
    }),
  ),
  skipped: z.string().optional(),
});
export type AuditOutput = z.infer<typeof AuditOutputSchema>;

export function parseAuditOutput(stdout: string): AuditOutput {
  return AuditOutputSchema.parse(JSON.parse(stdout));
}

/** Expected side adds CLEAN (no entry in the case's map); predicted side adds what a sweep can also produce. */
export const EXPECTED_LABELS = ["CLEAN", "TEST_DRIFT", "SPEC_CHANGE"] as const;
export const PREDICTED_LABELS = ["CLEAN", "TEST_DRIFT", "SPEC_CHANGE", "UNKNOWN", "ERROR"] as const;
export type ExpectedLabel = (typeof EXPECTED_LABELS)[number];
export type PredictedLabel = (typeof PREDICTED_LABELS)[number];

export type SubAnswerField = "surface" | "subDiagnosis" | "specChangeKind";

export interface SubAnswerOutcome {
  field: SubAnswerField;
  expected: string;
  got: string | null;
  match: boolean;
}

export interface AuditSpecOutcome {
  spec: string;
  expected: ExpectedLabel;
  predicted: PredictedLabel;
  labelMatch: boolean;
  /** The model's one-line finding, kept for reading a miss without re-running. */
  headline: string | null;
  /** Scored only when the label matched — see `AuditExpectationSchema`. */
  subAnswers: SubAnswerOutcome[];
}

/**
 * Score one case's sweep: every audited spec against the case's expectation
 * map, specs absent from the map expected CLEAN. The unmutated specs are as
 * much part of the measurement as the mutated one — a false finding on them
 * is the audit crying wolf.
 */
export function scoreAuditCase(
  expectations: Readonly<Record<string, AuditExpectation>>,
  output: AuditOutput,
): AuditSpecOutcome[] {
  return output.specs.map((row) => {
    const key = `${row.feature}/${row.spec}`;
    const expectation = expectations[key];
    const expected: ExpectedLabel = expectation?.label ?? "CLEAN";
    const predicted = predictedLabel(row);
    const labelMatch = predicted === expected;
    return {
      spec: key,
      expected,
      predicted,
      labelMatch,
      headline: row.drift?.headline ?? null,
      subAnswers: labelMatch && expectation ? scoreSubAnswers(expectation, row) : [],
    };
  });
}

function predictedLabel(row: AuditOutput["specs"][number]): PredictedLabel {
  if (!row.ok) return "ERROR";
  if (row.drift === null) return "CLEAN";
  const label = row.drift.label;
  return label === "TEST_DRIFT" || label === "SPEC_CHANGE" || label === "UNKNOWN" ? label : "ERROR";
}

function scoreSubAnswers(
  expectation: AuditExpectation,
  row: AuditOutput["specs"][number],
): SubAnswerOutcome[] {
  const out: SubAnswerOutcome[] = [];
  const fields: SubAnswerField[] = ["surface", "subDiagnosis", "specChangeKind"];
  for (const field of fields) {
    const expected = expectation[field];
    if (expected === undefined) continue;
    const got = row.drift?.[field] ?? null;
    out.push({ field, expected, got, match: got === expected });
  }
  return out;
}

export interface ConfusionMatrix {
  /** rows: expected label; columns: predicted label; cells: spec-verdict counts. */
  matrix: Record<ExpectedLabel, Record<PredictedLabel, number>>;
  total: number;
  correct: number;
  accuracy: number;
  subAnswers: { total: number; correct: number };
}

export function buildConfusionMatrix(outcomes: readonly AuditSpecOutcome[]): ConfusionMatrix {
  const matrix = Object.fromEntries(
    EXPECTED_LABELS.map((e) => [e, Object.fromEntries(PREDICTED_LABELS.map((p) => [p, 0]))]),
  ) as ConfusionMatrix["matrix"];
  let correct = 0;
  let subTotal = 0;
  let subCorrect = 0;
  for (const outcome of outcomes) {
    matrix[outcome.expected][outcome.predicted]++;
    if (outcome.labelMatch) correct++;
    for (const sub of outcome.subAnswers) {
      subTotal++;
      if (sub.match) subCorrect++;
    }
  }
  return {
    matrix,
    total: outcomes.length,
    correct,
    accuracy: outcomes.length === 0 ? 0 : correct / outcomes.length,
    subAnswers: { total: subTotal, correct: subCorrect },
  };
}
