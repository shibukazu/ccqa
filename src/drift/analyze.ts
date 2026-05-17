import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { extractJsonBlock } from "../claude/extract-json.ts";
import { invokeClaudeStreaming } from "../claude/invoke.ts";
import { buildDriftSystemPrompt, buildDriftUserPrompt } from "../prompts/drift.ts";
import { tryReadSpecFile, type AvailableBlock } from "../store/index.ts";
import { DraftReportSchema, type DraftReport } from "../types.ts";
import type { SpecResult, SpecTarget } from "./types.ts";

export interface AnalyzeDriftInput {
  targets: SpecTarget[];
  cwd: string;
  blocks: AvailableBlock[];
  concurrency?: number;
  model?: string;
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
  const { targets, cwd, blocks, concurrency = DEFAULT_CONCURRENCY, model, onSpecStart } = input;

  const results: SpecResult[] = new Array(targets.length);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const idx = cursor++;
      if (idx >= targets.length) return;
      const target = targets[idx]!;
      onSpecStart?.(target);
      results[idx] = await checkSpec(target, { cwd, blocks, model });
    }
  };

  const pool = Array.from({ length: Math.min(concurrency, targets.length) }, () => worker());
  await Promise.all(pool);
  return results;
}

interface CheckSpecOptions {
  cwd: string;
  blocks: AvailableBlock[];
  model?: string;
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
      systemPrompt: buildDriftSystemPrompt(opts.blocks),
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
