import { Command } from "commander";
import { createInterface } from "node:readline";
import { ensureCcqaDir, getRecording, parseSpecPath, readSpecFile } from "../store/index.ts";
import { acquireSpecLock, SpecLockedError } from "../store/spec-lock.ts";
import { warnStaleBlockArtifacts } from "./stale-blocks.ts";
import { parseTestSpec } from "../spec/parser.ts";
import { loadProjectConfig, TargetConfigSchema } from "../config/project-config.ts";
import { resolveTarget, resolveTargetOverride } from "../targets/registry.ts";
import type { GenerateContext, GenerateResult, TargetPlugin } from "../targets/types.ts";
import type { FixMode } from "../diagnose/loop.ts";
import type { RecordedAction } from "../types.ts";
import { addHubOptions, addLanguageOption, addProfileOption, applyProfileFromOption, DEFAULT_LANGUAGE } from "./options.ts";
import { resolveCwd } from "./resolve-cwd.ts";
import { resolveProject } from "./resolve-project.ts";
import { resolveHubClient, type HubContext } from "./hub-conn.ts";
import { syncSpecPerspectives } from "./perspectives-sync.ts";
import { updateAgentPrompt } from "./update-agent-prompt.ts";
import { buildGenerateRunSummary } from "./build-generate-run-summary.ts";
import * as log from "./logger.ts";

const AUTO_FIX_MODES = ["interactive", "auto", "skip"] as const;
export type AutoFixMode = (typeof AUTO_FIX_MODES)[number];

// Maps the user-facing `--auto-fix` 3-value flag to the internal `FixMode`.
// The two target families read the modes slightly differently:
//   interactive → agent-browser: prompt y/N when the auto-fix isn't
//                 high-confidence; external targets: show the fix diff and
//                 prompt y/N (declines on non-TTY).
//   auto        → never prompt; apply every fix (CI use).
//   skip        → agent-browser: apply only high-confidence fixes without
//                 prompting; external targets: run no fix pass at all.
export function toFixMode(autoFix: AutoFixMode): FixMode {
  switch (autoFix) {
    case "auto":
      return "auto";
    case "skip":
      return "non-interactive";
    case "interactive":
      return "interactive";
  }
}

/** Shared `--auto-fix` parser for the record / generate commands. */
export function parseAutoFixFlag(raw: string): AutoFixMode {
  if ((AUTO_FIX_MODES as readonly string[]).includes(raw)) return raw as AutoFixMode;
  throw new Error(`--auto-fix must be one of ${AUTO_FIX_MODES.join(" | ")}`);
}

export interface RunGenerateOptions {
  maxRetries: number;
  fixMode: FixMode;
  force: boolean;
  useSnapshot: boolean;
  language: string;
  model?: string;
  /** Generate through this target instead of the spec's own (CLI `--target`). */
  targetOverride?: string;
  /** Project root holding `.ccqa/`; defaults to process.cwd(). */
  cwd?: string;
  hubContext?: HubContext | null;
  /** Refresh the target's `<target>.agent` learning prompt from this run. */
  updateAgentPrompt?: boolean;
}

/**
 * The `generate` flow shared by `ccqa generate` and the codegen half of
 * `ccqa record`: resolve the spec's target plugin, load its input (the
 * recording, for input:"recording" targets), and dispatch to the plugin.
 * This layer owns the CLI concerns — overwrite confirmation, logging,
 * exit-code policy — while the plugin owns the generation pipeline.
 */
export async function runGenerate(
  featureName: string,
  specName: string,
  opts: RunGenerateOptions,
): Promise<void> {
  log.header("generate", `${featureName}/${specName}`);

  const cwd = opts.cwd ?? process.cwd();
  await ensureCcqaDir(cwd);

  // Concurrent generations of the same spec interleave recording / output /
  // manifest writes with no defined winner — the second caller fails fast.
  // Re-entrant under `ccqa record`, which holds the lock across trace +
  // generate in the same process.
  const releaseLock = await acquireSpecLock(featureName, specName, "generate", cwd);
  try {
    await runGenerateLocked(featureName, specName, opts, cwd);
  } finally {
    await releaseLock();
  }
}

/**
 * Resolve a spec's target, mapping a resolution failure (unknown target id,
 * agent-browser-only fields on another target) to a usage error + exit 2
 * instead of an unhandled throw. Shared by `ccqa generate` and `ccqa record`.
 */
export function resolveTargetOrExit(resolve: () => TargetPlugin): TargetPlugin {
  try {
    return resolve();
  } catch (e) {
    log.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  }
}

async function runGenerateLocked(
  featureName: string,
  specName: string,
  opts: RunGenerateOptions,
  cwd: string,
): Promise<void> {
  const specYaml = await readSpecFile(featureName, specName, cwd);
  const spec = parseTestSpec(specYaml);
  const config = await loadProjectConfig(cwd);
  const target = resolveTargetOrExit(() =>
    opts.targetOverride !== undefined
      ? resolveTargetOverride(spec, opts.targetOverride)
      : resolveTarget(spec, config),
  );
  log.meta("target", target.id + (opts.targetOverride !== undefined ? " (--target override)" : ""));

  // Refuse to overwrite previously generated output unless --force. The
  // target reports what would be clobbered (for agent-browser: test.spec.ts,
  // whose manual edits — e.g. patched selectors — would be silently lost).
  // We always confirm interactively (regardless of --auto / --no-interactive),
  // because overwriting a hand-edited file is a different kind of decision
  // than auto-applying an auto-fix and warrants an explicit y/N. CI flows
  // should pass --force.
  const existingOutput = (await target.existingOutput?.({ featureName, specName }, cwd)) ?? null;
  if (existingOutput && !opts.force) {
    const proceed = await confirmOverwrite(existingOutput);
    if (!proceed) {
      log.info("aborted; pass --force to overwrite without prompting");
      return;
    }
  }

  let recording: RecordedAction[] | undefined;
  if (target.input === "recording") {
    const { path: recordingPath, actions } = await getRecording(featureName, specName, cwd);
    log.meta("recording", recordingPath);
    log.meta("actions", actions.length);
    recording = actions;
  }

  await warnStaleBlockArtifacts();

  const targetConfig = config.targets[target.id] ?? TargetConfigSchema.parse({});
  const ctx: GenerateContext = {
    spec,
    specYaml,
    featureName,
    specName,
    cwd,
    recording,
    resources: targetConfig.resources,
    conventions: targetConfig.conventions,
    targetConfig,
    language: opts.language,
    model: opts.model,
    hub: opts.hubContext ?? null,
    fix: { maxRetries: opts.maxRetries, mode: opts.fixMode, useSnapshot: opts.useSnapshot },
  };

  const result = await target.generate(ctx);

  // Learn from this generation before the exit-code check: even a failed
  // generation carries a useful signal (the fix it couldn't land), and a
  // non-zero exit below would otherwise skip it.
  if (opts.updateAgentPrompt) {
    await runGenerateAgentPromptUpdate(target, featureName, specName, result, opts, cwd);
  }

  if (!result.passed) {
    log.warn("auto-fix exhausted; test still failing");
    process.exit(1);
  }
  log.hint(`run 'ccqa run ${featureName}/${specName}' to execute the test`);
}

/**
 * `ccqa generate --update-agent-prompt`: refresh the target's learned
 * `<target>.agent` playbook from this generation. Only targets that declare a
 * `guidanceKind` (the LLM-generating ones: playwright, runn) have such a
 * prompt — agent-browser's codegen is mechanical, so point at `ccqa record
 * --update-agent-prompt` for its tracer instead.
 */
async function runGenerateAgentPromptUpdate(
  target: TargetPlugin,
  featureName: string,
  specName: string,
  result: GenerateResult,
  opts: RunGenerateOptions,
  cwd: string,
): Promise<void> {
  if (target.guidanceKind === undefined) {
    log.warn(
      `--update-agent-prompt has no effect on the "${target.id}" target — it has no learned ` +
        `generation prompt (only LLM-generating targets like playwright/runn do)`,
    );
    return;
  }
  log.blank();
  await updateAgentPrompt({
    kind: target.guidanceKind,
    // The summary relativizes written-file paths against the project root, not
    // process.cwd() — under `--cwd <subpackage>` those differ, and a learned
    // playbook keyed on `../..`-style paths would be useless.
    runSummary: buildGenerateRunSummary(target.id, featureName, specName, result, cwd),
    hubContext: opts.hubContext ?? null,
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.language ? { language: opts.language } : {}),
  });
}

async function confirmOverwrite(path: string): Promise<boolean> {
  // Without a TTY (CI, piped stdin) we can't prompt. Refuse to overwrite —
  // CI/scripted callers should pass --force explicitly to opt in.
  if (!process.stdin.isTTY) {
    log.warn(`${path} exists and stdin is not a TTY; refusing to overwrite. Pass --force to allow.`);
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stdout.write("\n");
    process.stdout.write(`[warn] ${path} already exists.\n`);
    process.stdout.write(`[warn] generate will regenerate it and any manual edits will be lost.\n`);
    const answer = await new Promise<string>((res) => rl.question("Overwrite? [y/N] ", res));
    const norm = answer.trim().toLowerCase();
    return norm === "y" || norm === "yes";
  } finally {
    rl.close();
  }
}

interface GenerateCliOptions {
  model?: string;
  language?: string;
  profile?: string;
  target?: string;
  autoFix?: AutoFixMode;
  maxRetries?: string;
  force?: boolean;
  snapshot?: boolean;
  updateAgentPrompt?: boolean;
  cwd?: string;
  hubUrl?: string;
  hubToken?: string;
  hubHeader?: string[];
  project?: string;
}

export const generateCommand = addHubOptions(addProfileOption(addLanguageOption(
  new Command("generate")
    .argument(
      "<feature/spec>",
      "Spec id in '<feature>/<spec>' form (resolves to .ccqa/features/<feature>/test-cases/<spec>/)",
    )
    .description(
      "Generate test code from a spec via its target plugin. Recording-backed targets " +
        "compile the existing ir.json (run `ccqa record` first); spec-input targets " +
        "generate directly from the spec.",
    )
    .option(
      "-m, --model <name>",
      "Claude model alias ('sonnet'|'opus'|'haiku') or full ID. Overrides CCQA_MODEL.",
    )
    .option(
      "--target <id>",
      "Generate through this target instead of the spec's own — e.g. emit a Playwright " +
        "spec from an agent-browser recording. The spec's `target:` stays the default for `ccqa run`.",
    )
    .option(
      "--auto-fix <mode>",
      "Auto-fix behaviour during script generation: 'interactive' (default, prompt y/N; declines on non-TTY), 'auto' (apply without prompt, for CI), 'skip' (agent-browser: apply only high-confidence fixes; external targets like playwright/runn: no fix pass at all).",
      parseAutoFixFlag,
      "interactive" as AutoFixMode,
    )
    .option("--max-retries <n>", "Maximum number of auto-fix retries", "3")
    .option("--force", "Overwrite previously generated test code without warning")
    .option(
      "--no-snapshot",
      "Don't pin AGENT_BROWSER_SESSION / capture page snapshots after a failure (debug toggle)",
    )
    .option(
      "--update-agent-prompt",
      "After generation, ask Claude to refresh the target's \"<target>.agent\" learning prompt on the hub from a summary of the run. LLM-generating targets (playwright, runn) only; requires a hub connection.",
    )
    .option(
      "--cwd <path>",
      "Working directory containing the .ccqa/ tree (monorepo support). Defaults to the current directory.",
    )
    .option(
      "--project <name>",
      "Project name for the hub. Defaults to the current directory's name.",
    ),
))).action(async (specPath: string, opts: GenerateCliOptions) => {
  const { featureName, specName } = parseSpecPath(specPath);
  const language = opts.language ?? DEFAULT_LANGUAGE;

  // The generated test replays under vitest and resolves the spec's ${VAR}
  // references against process.env, so merge the profile (or default .env)
  // first — same contract as `ccqa record`.
  const cwd = resolveCwd(opts.cwd);
  const hubClient = resolveHubClient({ hubUrl: opts.hubUrl, hubToken: opts.hubToken, hubHeader: opts.hubHeader });
  // The project scope matters whenever a hub is configured (prompt lookups,
  // the perspectives auto-update), not only when --profile asks for hub
  // variables — resolve it in either case.
  const project = opts.profile !== undefined || hubClient !== null ? resolveProject(opts) : undefined;
  if (opts.profile !== undefined) {
    await applyProfileFromOption({
      profile: opts.profile,
      project: project!,
      cwd,
      hubUrl: opts.hubUrl,
      hubToken: opts.hubToken,
      hubHeader: opts.hubHeader,
    });
  } else {
    await applyProfileFromOption({ profile: undefined, project: "", cwd });
  }

  const hubContext: HubContext | null = hubClient && project ? { hub: hubClient, project } : null;

  try {
    await runGenerate(featureName, specName, {
      maxRetries: parseInt(opts.maxRetries ?? "3", 10),
      fixMode: toFixMode(opts.autoFix ?? "interactive"),
      force: opts.force ?? false,
      useSnapshot: opts.snapshot !== false,
      language,
      model: opts.model,
      targetOverride: opts.target,
      cwd,
      hubContext,
      updateAgentPrompt: opts.updateAgentPrompt ?? false,
    });
  } catch (e) {
    if (e instanceof SpecLockedError) {
      log.error(e.message);
      process.exit(2);
    }
    throw e;
  }

  // Keep the hub's coverage inventory in step with what was just generated.
  await syncSpecPerspectives(hubContext, {
    ref: { featureName, specName },
    ...(language ? { language } : {}),
    ...(opts.model ? { model: opts.model } : {}),
  });
});
