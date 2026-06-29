import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { extractJsonBlock } from "../claude/extract-json.ts";
import { invokeClaudeStreaming } from "../claude/invoke.ts";
import { buildDriftSystemPrompt, buildDriftUserPrompt } from "../prompts/drift.ts";
import { languageDirective } from "../prompts/language.ts";
import { tryReadSpecFile, type AvailableBlock } from "../store/index.ts";
import { runPool } from "../runtime/pool.ts";
import { DraftReportSchema, type DraftReport } from "../types.ts";
import type { SpecResult, SpecTarget } from "./types.ts";

export interface AnalyzeDriftInput {
  targets: SpecTarget[];
  cwd: string;
  blocks: AvailableBlock[];
  concurrency?: number;
  model?: string;
  /** BCP-47 tag or "auto"; controls the language of issue messages. */
  language?: string;
  /** Called once per spec when its check starts. Used by `cli/drift` for progress logging. */
  onSpecStart?: (target: SpecTarget) => void;
}

const DEFAULT_CONCURRENCY = 3;

/**
 * Run drift checks against a list of pre-collected targets. Pure library
 * function: no commander, no process.exit, no stdout writes. Callers handle
 * presentation. `cli/drift` does the full sweep with `--changed` scoping;
 * `cli/run` calls this with just the failing specs after vitest.
 */
export async function analyzeDrift(input: AnalyzeDriftInput): Promise<SpecResult[]> {
  const { targets, cwd, blocks, concurrency = DEFAULT_CONCURRENCY, model, language, onSpecStart } = input;

  return runPool(targets, concurrency, async (target) => {
    onSpecStart?.(target);
    return checkSpec(target, { cwd, blocks, model, language });
  });
}

interface CheckSpecOptions {
  cwd: string;
  blocks: AvailableBlock[];
  model?: string;
  language?: string;
}

async function checkSpec(target: SpecTarget, opts: CheckSpecOptions): Promise<SpecResult> {
  const { featureName, specName } = target;
  const existing = await tryReadSpecFile(featureName, specName, opts.cwd);
  if (existing === null) {
    return {
      target,
      ok: false,
      issues: [],
      error: `spec file disappeared after enumeration: ${featureName}/${specName}`,
    };
  }

  const { result, isError } = await invokeClaudeStreaming(
    {
      prompt: buildDriftUserPrompt(existing),
      systemPrompt: buildDriftSystemPrompt(opts.blocks) + languageDirective(opts.language),
      allowedTools: ["Read", "Grep", "Glob"],
      silenceBashLog: true,
      cwd: opts.cwd,
      ...(opts.model ? { model: opts.model } : {}),
    },
    (_msg: SDKMessage) => {},
  );

  if (isError) {
    return { target, ok: false, issues: [], error: "Claude returned an error result" };
  }

  const json = extractJsonBlock(result);
  if (!json) {
    return { target, ok: false, issues: [], error: "Claude did not return a json block" };
  }

  let report: DraftReport;
  try {
    report = DraftReportSchema.parse(JSON.parse(json));
  } catch (e) {
    return {
      target,
      ok: false,
      issues: [],
      error: `failed to parse drift report: ${(e as Error).message}`,
    };
  }

  return { target, ok: true, issues: report.issues };
}
