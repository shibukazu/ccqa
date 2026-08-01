import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { extractJsonBlock } from "../claude/extract-json.ts";
import { invokeClaudeStreaming } from "../claude/invoke.ts";
import {
  buildDriftSystemPrompt,
  buildDriftUserPrompt,
  type DriftGuidance,
} from "../prompts/drift.ts";
import { languageDirective } from "../prompts/language.ts";
import { normalizeDiagnosis } from "../report/schema.ts";
import { tryReadSpecFile, type AvailableBlock } from "../store/index.ts";
import { collectSpecArtifacts } from "./artifacts.ts";
import { runPool } from "../runtime/pool.ts";
import { DriftReplySchema, type SpecResult, type SpecTarget } from "./types.ts";

export interface AnalyzeDriftInput {
  targets: SpecTarget[];
  cwd: string;
  blocks: AvailableBlock[];
  concurrency?: number;
  model?: string;
  /** BCP-47 tag or "auto"; controls the language of issue messages. */
  language?: string;
  /** Project guidance from the hub (`audit.user` + `audit.agent`), resolved once. */
  guidance?: DriftGuidance;
  /** Called once per spec when its check starts. Used by `cli/audit` for progress logging. */
  onSpecStart?: (target: SpecTarget) => void;
  /**
   * Called once per spec as soon as its check lands, before the sweep ends.
   * `cli/audit` pushes the row to the hub here, so an interrupted sweep leaves
   * what it already paid for. Awaited, which lets a slow hub throttle the pool
   * rather than letting unsent rows pile up.
   */
  onSpecDone?: (result: SpecResult) => void | Promise<void>;
}

const DEFAULT_CONCURRENCY = 3;

/**
 * Run drift checks against a list of pre-collected targets. Pure library
 * function: no commander, no process.exit, no stdout writes. Callers handle
 * presentation. `cli/audit` does the full sweep with `--only-affected-by` scoping;
 * `cli/run` calls this with just the failing specs after vitest.
 */
export async function analyzeDrift(input: AnalyzeDriftInput): Promise<SpecResult[]> {
  const { targets, cwd, blocks, concurrency = DEFAULT_CONCURRENCY, model, language, guidance, onSpecStart, onSpecDone } =
    input;

  return runPool(targets, concurrency, async (target) => {
    onSpecStart?.(target);
    const result = await checkSpec(target, { cwd, blocks, model, language, guidance });
    await onSpecDone?.(result);
    return result;
  });
}

interface CheckSpecOptions {
  cwd: string;
  blocks: AvailableBlock[];
  model?: string;
  language?: string;
  /** Project guidance from the hub, resolved once by the caller. */
  guidance?: DriftGuidance;
}

async function checkSpec(target: SpecTarget, opts: CheckSpecOptions): Promise<SpecResult> {
  const { featureName, specName } = target;
  const existing = await tryReadSpecFile(featureName, specName, opts.cwd);
  if (existing === null) {
    return {
      target,
      ok: false,
      drift: null,
      error: `spec file disappeared after enumeration: ${featureName}/${specName}`,
    };
  }

  // Both surfaces of the test case, so the audit sees the code that actually
  // runs and not only the prose that describes it.
  const artifacts = await collectSpecArtifacts(featureName, specName, existing, opts.cwd);

  // One CI drift row shouldn't die on a single malformed reply (truncated
  // JSON, missing block) — retry the whole check once before reporting the
  // spec as errored.
  const MAX_ATTEMPTS = 2;
  let lastError = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const { result, isError } = await invokeClaudeStreaming(
      {
        prompt: buildDriftUserPrompt(artifacts),
        systemPrompt:
          buildDriftSystemPrompt(opts.blocks, opts.guidance ?? {}) + languageDirective(opts.language),
        allowedTools: ["Read", "Grep", "Glob"],
        silenceBashLog: true,
        cwd: opts.cwd,
        ...(opts.model ? { model: opts.model } : {}),
      },
      (_msg: SDKMessage) => {},
    );

    if (isError) {
      lastError = "Claude returned an error result";
      continue;
    }
    const json = extractJsonBlock(result);
    if (!json) {
      lastError = "Claude did not return a json block";
      continue;
    }
    try {
      const reply = DriftReplySchema.parse(JSON.parse(json));
      // Normalized here, at the only place a drift verdict enters the process,
      // so every consumer downstream — `--report-format json`, the report rows,
      // the hub push — sees a diagnosis that already obeys the label's rules.
      const drift = reply.drift ? normalizeDiagnosis(reply.drift) : null;
      return { target, ok: true, drift, live: artifacts.live, title: artifacts.title };
    } catch (e) {
      lastError = `failed to parse drift reply: ${(e as Error).message}`;
    }
  }
  return {
    target,
    ok: false,
    drift: null,
    error: `${lastError} (${MAX_ATTEMPTS} attempts)`,
    live: artifacts.live,
    title: artifacts.title,
  };
}
