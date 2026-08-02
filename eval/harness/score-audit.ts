import { AuditJsonPayloadSchema, type AuditJsonPayload } from "../../src/drift/format.ts";
import { DriftLabelSchema } from "../../src/report/schema.ts";
import type { AuditExpectation } from "./cases.ts";

export type AuditOutput = AuditJsonPayload;

export function parseAuditOutput(stdout: string): AuditOutput {
  return AuditJsonPayloadSchema.parse(JSON.parse(stdout));
}

/** Expected side adds CLEAN (no entry in the case's map); predicted side adds what a sweep can also produce. */
export const EXPECTED_LABELS = ["CLEAN", ...DriftLabelSchema.exclude(["UNKNOWN"]).options] as const;
export const PREDICTED_LABELS = ["CLEAN", ...DriftLabelSchema.options, "ERROR"] as const;
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
  const outcomes = output.specs.map((row) => {
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
  // An expectation the sweep never answered must count as a miss, not vanish
  // from the matrix.
  const answered = new Set(outcomes.map((o) => o.spec));
  for (const key of Object.keys(expectations)) {
    if (!answered.has(key)) {
      throw new Error(`the audit returned no verdict for expected spec "${key}"`);
    }
  }
  return outcomes;
}

function predictedLabel(row: AuditOutput["specs"][number]): PredictedLabel {
  if (!row.ok) return "ERROR";
  if (row.drift === null) return "CLEAN";
  const label = DriftLabelSchema.safeParse(row.drift.label);
  return label.success ? label.data : "ERROR";
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

export interface ClassRecall {
  correct: number;
  total: number;
}

export interface ConfusionMatrix {
  /** rows: expected label; columns: predicted label; cells: spec-verdict counts. */
  matrix: Record<ExpectedLabel, Record<PredictedLabel, number>>;
  total: number;
  correct: number;
  accuracy: number;
  /**
   * Per-class recall beside the total, because the total is dominated by the
   * CLEAN class: most specs in most cases are untouched, so answering clean
   * to everything already scores high on `accuracy` alone.
   */
  cleanRecall: ClassRecall;
  driftRecall: ClassRecall;
  subAnswers: { total: number; correct: number };
}

export function buildConfusionMatrix(outcomes: readonly AuditSpecOutcome[]): ConfusionMatrix {
  const matrix = Object.fromEntries(
    EXPECTED_LABELS.map((e) => [e, Object.fromEntries(PREDICTED_LABELS.map((p) => [p, 0]))]),
  ) as ConfusionMatrix["matrix"];
  let correct = 0;
  const cleanRecall: ClassRecall = { correct: 0, total: 0 };
  const driftRecall: ClassRecall = { correct: 0, total: 0 };
  let subTotal = 0;
  let subCorrect = 0;
  for (const outcome of outcomes) {
    matrix[outcome.expected][outcome.predicted]++;
    if (outcome.labelMatch) correct++;
    const recall = outcome.expected === "CLEAN" ? cleanRecall : driftRecall;
    recall.total++;
    if (outcome.labelMatch) recall.correct++;
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
    cleanRecall,
    driftRecall,
    subAnswers: { total: subTotal, correct: subCorrect },
  };
}
