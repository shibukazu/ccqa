import { readFile } from "node:fs/promises";
import { z } from "zod";
import { invokeClaudeStreaming } from "../claude/invoke.ts";
import { extractJsonBlock } from "../claude/extract-json.ts";
import * as log from "../cli/logger.ts";
import { verifiesSpecPrompt } from "../prompts/verifies-spec.ts";
import { isExpandedActionStep, type ExpandedStep } from "../spec/expand.ts";
import { assertionsByStep } from "../evidence/table.ts";
import { evidenceLabels, type EvidenceLabels } from "../evidence/labels.ts";
import type { GenerateResult } from "./types.ts";
import type { InvokeFn } from "./llm-engine.ts";

// `findings` は必須。既定値を与えると、キー名を間違えた返答や指摘を落とした
// 返答が parse に成功し、「点検して問題なし」として通ってしまう。プロンプトは
// 指摘が無いときも空配列を書かせる契約なので、必須にして困る正常系は無い。
const FindingsSchema = z.object({
  findings: z.array(z.object({ stepId: z.string(), problem: z.string() })),
});

/** One step whose assertions don't decide what the step claims. */
export type SpecCoverageFinding = z.infer<typeof FindingsSchema>["findings"][number];

/**
 * Findings in the model's answer, or null when it did not answer in the
 * agreed shape. Null is not "no findings": the caller says so rather than
 * reporting a clean review it never got.
 */
export function parseVerifiesSpecFindings(answer: string): SpecCoverageFinding[] | null {
  const json = extractJsonBlock(answer);
  if (!json) return null;
  try {
    return FindingsSchema.parse(JSON.parse(json)).findings;
  } catch {
    return null;
  }
}

/**
 * What a step with no assertion under it is told. Shared with the evidence
 * table, which reaches the same verdict from the same file — a reader must not
 * meet two wordings for one fact.
 *
 * It reports what was seen, not what was concluded. An assertion a rewrite
 * moved into a page object is invisible here, and calling that "decides
 * nothing" would be ccqa claiming more than it looked at.
 */
export const NOTHING_DECIDED =
  "no assertion is visible under this step in the generated test — one moved into a helper does " +
  "not show here, and does not show to a reviewer reading the file either";

/**
 * The warning a finding becomes, phrased so the reader knows the test is green
 * for nothing. A step deciding nothing is its own explanation, so only the
 * model's own words are worth appending.
 */
export function formatFinding(finding: SpecCoverageFinding, labels: EvidenceLabels = evidenceLabels()): string {
  const nothing = finding.problem === NOTHING_DECIDED;
  const claim = nothing ? labels.findingNothing : labels.findingUndecided;
  return `${finding.stepId}: ${claim}${nothing ? "" : ` — ${finding.problem}`}`;
}

/**
 * What the review found, for a caller that keeps it rather than only printing
 * it. `findings: null` is "no review happened" — which is not the same as a
 * clean one, and a reader of the record must be able to tell them apart.
 */
export interface SpecCoverageReview {
  findings: SpecCoverageFinding[] | null;
  /**
   * False when the model's half could not be obtained. The mechanical half
   * still ran, so `findings` may be an empty array — which must not read as a
   * clean review, because only part of the review happened.
   */
  complete: boolean;
  /** The findings as the lines the generate log shows. */
  warnings: string[];
}

/**
 * Read the generated test back and ask whether each step is actually decided
 * (see `verifiesSpecPrompt`). A review that could not be obtained answers
 * `findings: null` and is logged — it must not read as a pass, and it must
 * also not fail the generate that produced working files.
 */
export async function reviewGeneratedTest(input: {
  result: GenerateResult;
  steps: readonly ExpandedStep[];
  /**
   * What the case states for the flow as a whole, when its steps carry no
   * `expected` of their own. Without it a markdown case gives the model steps
   * that claim nothing, and the honest answer to "does the test decide this"
   * is then always yes.
   */
  expectations?: readonly string[];
  /** Cleanup steps, when the case says what its undo must make true. */
  cleanup?: readonly ExpandedStep[];
  language: string;
  model?: string;
  cwd: string;
  /** Test seam — defaults to `invokeClaudeStreaming`. */
  invoke?: InvokeFn;
}): Promise<SpecCoverageReview> {
  const sources = await Promise.all(
    input.result.files
      .filter((f) => f.kind === "test")
      .map((f) => readFile(f.path, "utf8").catch(() => "")),
  );
  const source = sources.filter((s) => s.length > 0).join("\n\n");
  if (source.length === 0) {
    log.warn("could not check whether the generated test decides its spec (no test file to read)");
    return { findings: null, complete: false, warnings: [] };
  }

  // Asked of the file, not of the model: a step with no assertion under it is
  // a fact anyone can read off the source, and the evidence table reads it the
  // same way — so the two must not be able to disagree about it.
  const checked = assertionsByStep(source);
  const undecided = [...input.steps, ...(input.cleanup ?? [])]
    .filter(isExpandedActionStep)
    .filter((step) => (checked.get(step.id) ?? []).length === 0)
    .map((step) => ({ stepId: step.id, problem: NOTHING_DECIDED }));

  const invoke = input.invoke ?? invokeClaudeStreaming;
  const { result: answer, isError } = await invoke({
    prompt: verifiesSpecPrompt({
      steps: input.steps,
      source,
      language: input.language,
      ...(input.expectations && input.expectations.length > 0
        ? { expectations: [...input.expectations] }
        : {}),
      ...(input.cleanup && input.cleanup.length > 0 ? { cleanup: [...input.cleanup] } : {}),
    }),
    allowedTools: [],
    disableThinking: true,
    maxTurns: 1,
    silenceBashLog: true,
    ...(input.model ? { model: input.model } : {}),
    cwd: input.cwd,
  }, () => {});
  // A review that could not be obtained still leaves the mechanical half,
  // which needed no model: reporting nothing here would read as a clean pass.
  const fromModel = isError ? null : parseVerifiesSpecFindings(answer);
  if (fromModel === null) {
    log.warn(
      `could not check whether the generated test decides its spec (${isError ? "Claude returned an error" : "no usable answer"})`,
    );
  }
  const findings = mergeFindings(undecided, fromModel ?? []);
  return { findings, complete: fromModel !== null, warnings: findings.map((finding) => formatFinding(finding)) };
}

/**
 * The mechanical finding wins its step: it is a fact, not a reading. Shared
 * with the evidence table, which merges the same two sources — one of them
 * recomputed from the file as it is now — and must show each step once.
 */
export function mergeFindings(
  undecided: SpecCoverageFinding[],
  fromModel: readonly SpecCoverageFinding[],
): SpecCoverageFinding[] {
  const claimed = new Set(undecided.map((f) => f.stepId));
  return [...undecided, ...fromModel.filter((f) => !claimed.has(f.stepId))];
}
