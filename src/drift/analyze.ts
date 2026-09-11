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
import type { AvailableBlock } from "../store/index.ts";
import type { SourceRoot } from "../config/source-roots.ts";
import {
  collectCaseArtifacts,
  loadSpecArtifactsContext,
  type SpecArtifactsContext,
} from "./artifacts.ts";
import { runPool } from "../runtime/pool.ts";
import { writeAuditInputs } from "./dump-inputs.ts";
import { buildLocatorInventory, checkLocatorVerdicts } from "./locator-candidates.ts";
import { verifyCitations } from "./verify-citations.ts";
import { caseIdOf, DriftReplySchema, type SpecResult, type SpecTarget } from "./types.ts";
import * as log from "../cli/logger.ts";

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
  /**
   * Where the product's own source lives (`sourceRoots`), already resolved.
   * These widen what the model's Read/Grep may reach, which is what lets an
   * audit check a test against an application that lives outside this project.
   */
  sourceRoots?: readonly SourceRoot[];
  /** The sweep's config and import aliases, when the caller already read them. */
  context?: SpecArtifactsContext;
  /**
   * Directory to write each case's audit inputs into (`--dump-inputs`). Absent
   * writes nothing, which is the default.
   */
  dumpInputs?: string;
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
 * How many turns one case's audit may take.
 *
 * A runaway guard, not a working limit: reaching it costs the case a retry and
 * then an errored row rather than a partial answer, so it is set well above
 * what a large case needs — a locator list, the searches that check it, and
 * the reads that place them in context.
 */
const MAX_AUDIT_TURNS = 80;

/**
 * Run drift checks against a list of pre-collected targets. Pure library
 * function: no commander, no process.exit, no stdout writes. Callers handle
 * presentation. `cli/audit` does the full sweep with `--only-affected-by` scoping;
 * `cli/run` calls this with just the failing specs after vitest.
 */
export async function analyzeDrift(input: AnalyzeDriftInput): Promise<SpecResult[]> {
  const {
    targets,
    cwd,
    blocks,
    concurrency = DEFAULT_CONCURRENCY,
    model,
    language,
    guidance,
    sourceRoots = [],
    dumpInputs,
    onSpecStart,
    onSpecDone,
  } = input;
  // Read once for the sweep: every spec resolves its test through the same
  // config and the same import aliases, and neither can change mid-sweep. The
  // caller may pass its own when it has already built one.
  const context = input.context ?? (await loadSpecArtifactsContext(cwd));

  return runPool(targets, concurrency, async (target) => {
    onSpecStart?.(target);
    const result = await checkSpec(target, {
      cwd,
      context,
      blocks,
      model,
      language,
      guidance,
      sourceRoots,
      ...(dumpInputs !== undefined ? { dumpInputs } : {}),
    });
    await onSpecDone?.(result);
    return result;
  });
}

interface CheckSpecOptions {
  /** Config and import aliases, read once by `analyzeDrift`. */
  context: SpecArtifactsContext;
  cwd: string;
  /** Where the product's source lives, resolved once by the caller. */
  sourceRoots: readonly SourceRoot[];
  blocks: AvailableBlock[];
  model?: string;
  language?: string;
  /** Project guidance from the hub, resolved once by the caller. */
  guidance?: DriftGuidance;
  /** Where to write what this audit was given, when the caller asked for it. */
  dumpInputs?: string;
}

async function checkSpec(target: SpecTarget, opts: CheckSpecOptions): Promise<SpecResult> {
  const name = caseIdOf(target);

  // Both surfaces of the test case, so the audit sees the code that actually
  // runs and not only the prose that describes it.
  const artifacts = await collectCaseArtifacts(target, opts.cwd, opts.context).catch(
    (e: Error) => e,
  );
  if (artifacts instanceof Error) {
    return { target, ok: false, drift: null, error: `${name}: ${artifacts.message}` };
  }
  if (artifacts.unaudited.length > 0) {
    // Said out loud, not only in the prompt: a verdict of "no drift" over a
    // partially-read test case is worth less than it looks, and only the
    // operator can decide to split the spec or narrow its imports.
    log.warn(
      `${name}: over the audit's size budget — not audited: ${artifacts.unaudited.join(", ")}`,
    );
  }

  // One CI drift row shouldn't die on a single malformed reply (truncated
  // JSON, missing block) — retry the whole check once before reporting the
  // spec as errored.
  const locators = await buildLocatorInventory({
    sources: new Map(artifacts.generated.map((f) => [f.path, f.content])),
    roots: opts.sourceRoots.length > 0 ? opts.sourceRoots : [{ configured: ".", abs: opts.cwd }],
    cwd: opts.cwd,
  });
  const userPrompt = buildDriftUserPrompt(artifacts, opts.sourceRoots, locators);
  const systemPrompt =
    buildDriftSystemPrompt(opts.blocks, opts.guidance ?? {}, artifacts.intent.kind) +
    languageDirective(opts.language);
  if (opts.dumpInputs !== undefined) {
    // Written before the call, not after it: the reason to reach for this is
    // usually a sweep that answered nothing, and one that dies mid-way is
    // exactly when the inputs are worth having.
    await writeAuditInputs(opts.dumpInputs, {
      caseId: name,
      artifacts,
      sourceRoots: opts.sourceRoots,
      locators,
      systemPrompt,
      userPrompt,
    }).then(
      (path) => log.meta("inputs", path),
      // A side output that cannot be written must not discard a sweep that
      // has already paid for the answers it has.
      (err: Error) => log.warn(`${name}: could not write the audit inputs (${err.message})`),
    );
  }

  const MAX_ATTEMPTS = 2;
  let lastError = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const { result, isError } = await invokeClaudeStreaming(
      {
        // The retry says what was wrong with the first reply. Re-asking the
        // same question the same way mostly buys the same answer.
        prompt: lastError === "" ? userPrompt : `${userPrompt}\n## The previous reply was rejected\n\n${lastError}\n`,
        systemPrompt,
        allowedTools: ["Read", "Grep", "Glob"],
        // A ceiling, not a budget: the audit is asked to check a list of
        // locators, and a case with thirty of them must not be able to turn
        // that into thirty searches with nothing bounding the bill.
        maxTurns: MAX_AUDIT_TURNS,
        silenceBashLog: true,
        cwd: opts.cwd,
        additionalDirectories: opts.sourceRoots.map((root) => root.abs),
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
      const unanswered = checkLocatorVerdicts(locators.missing, reply);
      if (unanswered !== null) {
        lastError = unanswered;
        continue;
      }
      // Normalized here, at the only place a drift verdict enters the process,
      // so every consumer downstream — `--report-format json`, the report rows,
      // the hub push — sees a diagnosis that already obeys the label's rules.
      const drift = reply.drift ? normalizeDiagnosis(reply.drift) : null;
      // Checked before the finding is kept, so nothing downstream — the report,
      // the hub row, `--brief` — ever carries a line number nobody looked at.
      if (drift !== null && drift.evidence.length > 0) {
        drift.evidence = await verifyCitations(drift.evidence, {
          headline: drift.headline,
          roots: [...opts.sourceRoots.map((r) => r.abs), opts.cwd],
        });
      }
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
