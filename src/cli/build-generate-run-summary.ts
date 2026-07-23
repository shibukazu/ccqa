import { relative } from "node:path";
import type { GenerateResult } from "../targets/types.ts";

/**
 * Compact, prompt-friendly summary of one `ccqa generate` pass for the
 * `<target>.agent` learning step (see agent-update.ts). It reports the outcome
 * the learner reasons over: which files landed, whether the target's runCommand
 * verification ultimately passed, and any warnings the pass raised (a
 * verification failure surfaces here as `passed: false` plus the fix warnings).
 *
 * The engine doesn't thread the individual verify/fix transcripts out, so the
 * summary is outcome-level rather than turn-by-turn — enough for the learner to
 * record "this repo needed X" from a run that struggled, and to answer
 * NO_UPDATE for a clean first-try generation.
 */
export function buildGenerateRunSummary(
  targetId: string,
  featureName: string,
  specName: string,
  result: GenerateResult,
  cwd: string = process.cwd(),
): string {
  const files = result.files.length
    ? result.files
        .map((f) => `- ${relative(cwd, f.path)} (${f.kind})`)
        .join("\n")
    : "- (none written)";
  const warnings = result.warnings.length
    ? result.warnings.map((w) => `- ${w}`).join("\n")
    : "- (none)";
  return [
    `## ${targetId} generation — ${featureName}/${specName}`,
    `verification: ${result.passed ? "passed" : "FAILED (auto-fix exhausted)"}`,
    "",
    "### Files written",
    files,
    "",
    "### Generation summary",
    result.summary || "(no summary)",
    "",
    "### Warnings",
    warnings,
  ].join("\n");
}
