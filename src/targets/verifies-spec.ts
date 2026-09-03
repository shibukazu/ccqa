import { readFile } from "node:fs/promises";
import { z } from "zod";
import { invokeClaudeStreaming } from "../claude/invoke.ts";
import { extractJsonBlock } from "../claude/extract-json.ts";
import * as log from "../cli/logger.ts";
import { verifiesSpecPrompt } from "../prompts/verifies-spec.ts";
import type { ExpandedStep } from "../spec/expand.ts";
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

/** The warning a finding becomes, phrased so the reader knows the test is green for nothing. */
export function formatFinding(finding: SpecCoverageFinding): string {
  return (
    `step ${finding.stepId}: the generated test passes without deciding what this step claims — ` +
    `${finding.problem}`
  );
}

/**
 * Read the generated test back and ask whether each step is actually decided
 * (see `verifiesSpecPrompt`). Returns warnings; an empty list means either a
 * clean review or one that could not be obtained, and the difference is
 * logged rather than encoded — a review that failed must not read as a pass,
 * but it must also not fail the generate that produced working files.
 */
export async function reviewGeneratedTest(input: {
  result: GenerateResult;
  steps: readonly ExpandedStep[];
  language: string;
  model?: string;
  cwd: string;
  /** Test seam — defaults to `invokeClaudeStreaming`. */
  invoke?: InvokeFn;
}): Promise<string[]> {
  const sources = await Promise.all(
    input.result.files
      .filter((f) => f.kind === "test")
      .map((f) => readFile(f.path, "utf8").catch(() => "")),
  );
  const source = sources.filter((s) => s.length > 0).join("\n\n");
  if (source.length === 0) {
    log.warn("could not check whether the generated test decides its spec (no test file to read)");
    return [];
  }

  const invoke = input.invoke ?? invokeClaudeStreaming;
  const { result: answer, isError } = await invoke({
    prompt: verifiesSpecPrompt({ steps: input.steps, source, language: input.language }),
    allowedTools: [],
    disableThinking: true,
    maxTurns: 1,
    silenceBashLog: true,
    ...(input.model ? { model: input.model } : {}),
    cwd: input.cwd,
  }, () => {});
  if (isError) {
    log.warn("could not check whether the generated test decides its spec (Claude returned an error)");
    return [];
  }
  const findings = parseVerifiesSpecFindings(answer);
  if (findings === null) {
    log.warn("could not check whether the generated test decides its spec (no usable answer)");
    return [];
  }
  return findings.map(formatFinding);
}
