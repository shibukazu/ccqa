import { withUsageErrors } from "./usage-errors.ts";
import { RunUsageError } from "../run/errors.ts";
import { Command } from "commander";
import { createInterface } from "node:readline";
import { readFile, stat, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import {
  ensureCcqaDir,
  fileSha256,
  matchesGenerationStamp,
  getRecording,
  splitCaseId,
  stampGeneratedTest,
  type Recording,
} from "../store/index.ts";

/** What `ccqa generate` last wrote from this route (`ir.json`'s `generated`). */
type GenerationStamp = NonNullable<Recording["generated"]>;
import { resolveTestPath } from "../targets/test-path.ts";
import { checkRecordedRouteReplays } from "./replay-gate.ts";
import { resolveCase, type ResolvedCase } from "./resolve-case.ts";
import { replaceSectionBody } from "../intent/markdown.ts";
import { loadEnvFiles } from "./env-files.ts";
import { acquireSpecLock, SpecLockedError } from "../store/spec-lock.ts";
import { warnStaleBlockArtifacts } from "./stale-blocks.ts";
import { parseTestSpec } from "../spec/parser.ts";
import { loadProjectConfig, type TargetConfig } from "../config/project-config.ts";
import { resolveLanguage } from "../prompts/language.ts";
import { resolveTargetOverride } from "../targets/registry.ts";
import type { GenerateContext, GenerateResult, TargetPlugin } from "../targets/types.ts";
import type { FixMode } from "../diagnose/loop.ts";
import type { RecordedAction } from "../types.ts";
import { addHubOptions, addLanguageOption, addProfileOption, applyProfileFromOption, DEFAULT_LANGUAGE } from "./options.ts";
import { resolveCwd } from "./resolve-cwd.ts";
import { resolveProject } from "./resolve-project.ts";
import { resolveHubClient, type HubContext } from "./hub-conn.ts";
import { createRunTeardown, installTeardownSignalHandlers, type RunTeardown } from "./run-teardown.ts";
import { needsHubConnection } from "./open-hub-run.ts";
import { updateAgentPrompt } from "./update-agent-prompt.ts";
import { buildGenerateRunSummary } from "./build-generate-run-summary.ts";
import { actionTexts, findLoadedValueLiterals } from "../runtime/env-scrub.ts";
import * as log from "./logger.ts";
import { withCostReporting } from "./cost-line.ts";

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
  /** `--overwrite`: replace an existing generated test without the y/N prompt. */
  force: boolean;
  /**
   * Replay the saved route before recompiling it (`--no-replay` turns it off).
   * False for `ccqa record`, whose trace just validated the route it wrote.
   */
  replayGate: boolean;
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
  /** The caller's signal teardown; targets register pinned browser sessions with it. */
  teardown?: RunTeardown;
}

/**
 * The `generate` flow shared by `ccqa generate` and the codegen half of
 * `ccqa record`: resolve the spec's target plugin, load its input (the
 * recording, for input:"recording" targets), and dispatch to the plugin.
 * This layer owns the CLI concerns — the regeneration gates, logging — while
 * the plugin owns the generation pipeline. A generation whose output still
 * fails is reported as `{ passed: false }` rather than thrown or exited: both
 * callers have work left that `process.exit` would skip — `ccqa record
 * --report-to-hub` still has to seal the run holding what the retries cost.
 */
export async function runGenerate(
  resolved: ResolvedCase,
  opts: RunGenerateOptions,
): Promise<{ passed: boolean }> {
  log.header("generate", resolved.testCase.ref.id);

  const cwd = opts.cwd ?? process.cwd();
  await ensureCcqaDir(cwd);

  // Concurrent generations of the same case interleave recording and output
  // writes with no defined winner — the second caller fails fast.
  // Re-entrant under `ccqa record`, which holds the lock across trace +
  // generate in the same process.
  const releaseLock = await acquireSpecLock(resolved.testCase.ref, "generate");
  try {
    return await runGenerateLocked(resolved, opts, cwd);
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
  resolved: ResolvedCase,
  opts: RunGenerateOptions,
  cwd: string,
): Promise<{ passed: boolean }> {
  const { testCase, target, targetConfig, testPath } = resolved;
  // The project's saved browser state, for the replay gate below: a case whose
  // precondition is "signed in" replays against a sign-in wall without it.
  const { sessionState } = await loadProjectConfig(cwd);
  const spec = testCase.source.kind === "spec" ? testCase.source.spec : null;
  // Same gate as `ccqa record`: a live spec has no recording to compile, and
  // `ccqa run` ignores generated code for it — a spec switched to live after
  // it was once recorded would otherwise still compile a test nothing runs.
  if (spec?.mode === "live") {
    log.error(
      `this spec is 'mode: live' — a live spec runs without generated code. Run 'ccqa run ${testCase.ref.id}' instead`,
    );
    process.exit(2);
  }
  log.meta("target", target.id + (opts.targetOverride !== undefined ? " (--target override)" : ""));
  log.meta("test", testPath);

  const testPathAbs = resolve(cwd, testPath);
  let recording: RecordedAction[] | undefined;
  let cleanupRecording: RecordedAction[] | undefined;
  let stamp: GenerationStamp | undefined;
  if (target.input === "recording") {
    const saved = await getRecording(testCase.ref);
    log.meta("recording", `${saved.path}${saved.recordedAt ? ` (recorded ${saved.recordedAt})` : ""}`);
    log.meta("actions", saved.actions.length);
    recording = saved.actions;
    cleanupRecording = saved.cleanup;
    stamp = saved.generated;
    // A route recorded before the project pointed ccqa at its variables kept
    // their values as literals, and nothing since would have noticed. Refused
    // here rather than warned about: compiling it produces a test holding the
    // same values, which the write gate refuses anyway — a page later, and
    // about the generated file rather than about the route that caused it.
    const baked = findLoadedValueLiterals(
      [...saved.actions, ...(saved.cleanup ?? [])].flatMap(actionTexts),
    );
    if (baked.length > 0) {
      throw new RunUsageError(
        `${saved.path} holds the resolved value of ${baked.join(", ")} rather than the reference. ` +
          `Re-record this case ('ccqa record ${testCase.ref.id}') so the route carries \${VAR}.`,
      );
    }
  }

  // One guard over the file about to be replaced, with three answers: ccqa
  // wrote it and nobody has touched it (regenerate silently), someone edited
  // it (refuse — that edit is work), or there is no stamp to tell the two
  // apart (ask). Thrown rather than exited: the case lock is held here, and
  // `process.exit` would skip its release.
  const handEdit = await handEditRefusal({
    key: testCase.ref.id,
    testPath,
    testPathAbs,
    stamp: stamp ?? null,
    force: opts.force,
  });
  if (handEdit !== null) throw new RunUsageError(handEdit);
  if (stamp === undefined && !opts.force && (await fileSha256(testPathAbs)) !== null) {
    if (!(await confirmOverwrite(testPath))) {
      log.info("aborted; pass --overwrite to replace it without prompting");
      // Declining is not a failed generation: nothing was generated to fail.
      return { passed: true };
    }
  }

  // A route the application has outgrown can only compile into a test that
  // cannot pass, so it is refused before any generation work is paid for.
  if (recording && opts.replayGate) {
    const dead = await checkRecordedRouteReplays({
      ref: testCase.ref,
      cwd,
      recording,
      ...(cleanupRecording ? { cleanup: cleanupRecording } : {}),
      ...(sessionState ? { sessionState } : {}),
      ...(opts.teardown ? { teardown: opts.teardown } : {}),
    });
    if (dead) throw new RunUsageError(dead);
  }

  await warnStaleBlockArtifacts();

  const { featureName, specName } = splitCaseId(testCase.ref.id);
  const ctx: GenerateContext = {
    // A case from the project's own documents has no `spec.yaml`; what every
    // target actually reads off it is the title, and its steps come already
    // expanded on the context.
    spec: spec ?? { title: testCase.title, steps: [] },
    specYaml: testCase.source.kind === "spec" ? testCase.source.yaml : "",
    featureName,
    specName,
    ref: testCase.ref,
    steps: testCase.steps,
    cleanup: testCase.cleanup,
    expectations: testCase.expectations,
    cleanupExpectations: testCase.cleanupExpectations,
    fields: testCase.fields,
    cwd,
    testPath,
    recording,
    ...(cleanupRecording ? { cleanupRecording } : {}),
    resources: targetConfig.resources,
    conventions: targetConfig.conventions,
    targetConfig,
    language: opts.language,
    model: opts.model,
    hub: opts.hubContext ?? null,
    fix: { maxRetries: opts.maxRetries, mode: opts.fixMode, useSnapshot: opts.useSnapshot },
    teardown: opts.teardown,
  };

  const result = await target.generate(ctx);
  // Stamped after the write, from the file on disk: what the fix loop left is
  // what this generation produced, and it is that file the next one compares.
  if (target.input === "recording") {
    await stampGeneratedTest(testCase.ref, testPathAbs);
  }

  // The case asked to be told where its test ended up, so tell it — and
  // nothing else: the file is the project's, and exactly one section of it was
  // offered to ccqa.
  if (result.passed) await writeBackOutputPath(testCase, targetConfig, testPath);

  // Learn from a failed generation too: the fix it couldn't land is a signal.
  if (opts.updateAgentPrompt) {
    await runGenerateAgentPromptUpdate(target, testCase.ref.id, result, opts, cwd);
  }

  if (!result.passed) log.warn("auto-fix exhausted; test still failing");
  else log.hint(`run 'ccqa run ${testCase.ref.id}' to execute the test`);
  return { passed: result.passed };
}

/**
 * `ccqa generate --learn-hub-codegen-prompt`: refresh the target's learned
 * `<target>.agent` playbook from this generation. Only targets that declare a
 * `guidanceKind` (the LLM-generating ones: playwright, runn) have such a
 * prompt — agent-browser's codegen is mechanical, so point at `ccqa record
 * --learn-hub-trace-prompt` for its tracer instead.
 */
async function runGenerateAgentPromptUpdate(
  target: TargetPlugin,
  caseId: string,
  result: GenerateResult,
  opts: RunGenerateOptions,
  cwd: string,
): Promise<void> {
  if (target.guidanceKind === undefined) {
    log.warn(
      `--learn-hub-codegen-prompt has no effect on the "${target.id}" target — it has no learned ` +
        `generation prompt (only LLM-generating targets like playwright/runn do)`,
    );
    return;
  }
  log.blank();
  await updateAgentPrompt({
    kind: target.guidanceKind,
    flag: "--learn-hub-codegen-prompt",
    // The summary relativizes written-file paths against the project root, not
    // process.cwd() — under `--cwd <subpackage>` those differ, and a learned
    // playbook keyed on `../..`-style paths would be useless.
    runSummary: buildGenerateRunSummary(target.id, caseId, result, cwd),
    hubContext: opts.hubContext ?? null,
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.language ? { language: opts.language } : {}),
  });
}

/**
 * Write the generated test's path into the case's own `outputPath` section.
 *
 * Only when the project named that section and the case actually has it: a
 * case file belongs to the project, and ccqa rewrites the one heading it was
 * given permission to rewrite, leaving every other byte alone.
 */
async function writeBackOutputPath(
  testCase: ResolvedCase["testCase"],
  targetConfig: TargetConfig,
  testPath: string,
): Promise<void> {
  const heading = targetConfig.intent?.fields.outputPath;
  if (!heading || testCase.source.kind !== "markdown") return;
  // Read again rather than reusing the copy the case was parsed from: a
  // generation with auto-fix runs for minutes, and writing back a stale copy
  // would silently undo whatever was edited in that window.
  const { path } = testCase.source;
  const before = await readFile(path, "utf8").catch(() => null);
  if (before === null) return;
  const after = replaceSectionBody(before, heading, testPath);
  if (after === null) {
    log.warn(`the case has no "${heading}" section, so the generated test's path was not written back`);
    return;
  }
  if (after === before) return;
  await writeFile(path, after, "utf8");
  log.meta("wrote back", `${heading} in ${relative(process.cwd(), path) || path}`);
}

/**
 * The reason regeneration is refused because the test on disk is not the one
 * the last generation wrote — or null when it may proceed. A matching stamp
 * means ccqa produced this file, so regenerating it costs nobody anything and
 * happens without asking.
 */
async function handEditRefusal(input: {
  key: string;
  testPath: string;
  testPathAbs: string;
  stamp: GenerationStamp | null;
  force: boolean;
}): Promise<string | null> {
  if (input.stamp === null || input.force) return null;
  if (await matchesGenerationStamp(input.stamp, input.testPathAbs)) return null;
  return (
    `${input.testPath} is not the file ccqa generated on ${input.stamp.at} — it was edited by hand. ` +
    `Regenerating would discard that edit, so fix it where it came from: re-record with ` +
    `'ccqa record ${input.key}' to fold the change into the route, or repair the test in its own repo. ` +
    `Pass --overwrite to regenerate over it anyway.`
  );
}

async function confirmOverwrite(path: string): Promise<boolean> {
  // Without a TTY (CI, piped stdin) we can't prompt. Refuse to overwrite —
  // CI/scripted callers should pass --overwrite explicitly to opt in.
  if (!process.stdin.isTTY) {
    log.warn(`${path} exists and stdin is not a TTY; refusing to overwrite. Pass --overwrite to allow.`);
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
  hubProfile?: string;
  target?: string;
  autoFix?: AutoFixMode;
  autoFixMaxRetries?: string;
  overwrite?: boolean;
  replay?: boolean;
  sessionPin?: boolean;
  learnHubCodegenPrompt?: boolean;
  cwd?: string;
  hubUrl?: string;
  hubToken?: string;
  hubHeader?: string[];
  project?: string;
}

/**
 * Say so when the case has been edited since it was recorded.
 *
 * Generation compiles the route, not the document: a step added to the case or
 * an expectation reworded changes nothing until the case is recorded again.
 * The generated test then comes out to the old case and passes, and the only
 * clue is that what you just wrote is not in it — which reads as the generator
 * ignoring you rather than as a stale recording. Cheap to say, and the one
 * thing that makes the next step obvious.
 */
async function warnIfCaseOutranRecording(
  testCase: { source: { kind: string; path?: string }; ref: { id: string } },
  recordedAt: string | undefined,
): Promise<void> {
  const path = testCase.source.path;
  if (recordedAt === undefined || path === undefined) return;
  const edited = await stat(path).then((st) => st.mtime, () => null);
  if (edited === null || edited.getTime() <= new Date(recordedAt).getTime()) return;
  log.warn(
    `the case was edited after it was recorded (case ${edited.toISOString()}, recording ${recordedAt}). ` +
      `Generation compiles the recording, so anything added to the case since is not in it — ` +
      `run 'ccqa record ${testCase.ref.id}' if the steps or the expected results changed.`,
  );
}

export const generateCommand = addHubOptions(addProfileOption(addLanguageOption(
  new Command("generate")
    .argument(
      "<case>",
      "The case to generate from: a spec id ('<feature>/<spec>'), or — for a target that reads an intent source — a case id or the path of its source file",
    )
    .description(
      "Generate test code from a case via its target. Recording-backed targets compile the " +
        "existing ir.json (run `ccqa record` first); spec-input targets generate directly " +
        "from the spec.",
    )
    .optionsGroup("How to generate:")
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
    .option("--auto-fix-max-retries <n>", "Maximum number of auto-fix retries", "3")
    .option(
      "--no-replay",
      "Skip replaying the saved recording before regenerating from it. The replay drives your application for real — it performs the recorded actions, and whatever they create the recorded cleanup then tries to remove — and it needs a browser and the spec's variables. Skip it where that is unwelcome or unavailable, and accept that a route the application has outgrown regenerates into a test that cannot pass.",
    )
    .option(
      "--no-session-pin",
      "Don't pin AGENT_BROWSER_SESSION / capture page snapshots after a failure (debug toggle)",
    )
    .optionsGroup("What to do with the result:")
    .option(
      "--overwrite",
      "Replace an existing generated test without the y/N prompt (declines on a non-TTY)",
    )
    .optionsGroup("Learning:")
    .option(
      "--learn-hub-codegen-prompt",
      "After generation, ask Claude to refresh the target's \"<target>.agent\" learning prompt on the hub from a summary of the run. LLM-generating targets (playwright, runn) only; requires a hub connection.",
    )
    .optionsGroup("Environment and connection:")
    .option(
      "--cwd <path>",
      "Working directory containing the .ccqa/ tree (monorepo support). Defaults to the current directory.",
    )
    .option(
      "--project <name>",
      "Project name for the hub. Defaults to the current directory's name.",
    ),
))).action(withUsageErrors(async (specPath: string, opts: GenerateCliOptions) => {
  await withCostReporting("generate", () => runGenerateCli(specPath, opts));
}));

async function runGenerateCli(caseArgument: string, opts: GenerateCliOptions): Promise<void> {
  let language = opts.language ?? DEFAULT_LANGUAGE;

  // The generated test replays under vitest and resolves the spec's ${VAR}
  // references against process.env, so merge the profile (or default .env)
  // first — same contract as `ccqa record`.
  const cwd = resolveCwd(opts.cwd);
  const hubClient = resolveHubClient({ hubUrl: opts.hubUrl, hubToken: opts.hubToken, hubHeader: opts.hubHeader });
  // The project scope matters whenever a hub is configured (prompt lookups,
  // the perspectives auto-update), not only when --hub-profile asks for hub
  // variables — resolve it in either case.
  const project = opts.hubProfile !== undefined || hubClient !== null ? resolveProject(opts) : undefined;
  if (opts.hubProfile !== undefined) {
    await applyProfileFromOption({
      profile: opts.hubProfile,
      project: project!,
      cwd,
      hubUrl: opts.hubUrl,
      hubToken: opts.hubToken,
      hubHeader: opts.hubHeader,
    });
  } else {
    await applyProfileFromOption({ profile: undefined, project: "", cwd });
  }

  if (opts.learnHubCodegenPrompt && hubClient === null) {
    log.error(needsHubConnection("--learn-hub-codegen-prompt"));
    process.exit(2);
  }
  const hubContext: HubContext | null = hubClient && project ? { hub: hubClient, project } : null;

  // `ccqa record` hands its own teardown down; standalone `ccqa generate` owns
  // one here, so an interrupted generation still reaps the browser session the
  // target pinned.
  const teardown = createRunTeardown();
  const disposeSignalHandlers = installTeardownSignalHandlers(teardown);
  let passed: boolean;
  try {
    const config = await loadProjectConfig(cwd);
    language = resolveLanguage(opts.language, config.language);
    await loadEnvFiles(config.envFiles, cwd);
    const resolved = await resolveCase(caseArgument, config, cwd, {
      ...(opts.target ? { targetOverride: opts.target } : {}),
    });
    ({ passed } = await runGenerate(resolved, {
      maxRetries: parseInt(opts.autoFixMaxRetries ?? "3", 10),
      fixMode: toFixMode(opts.autoFix ?? "interactive"),
      force: opts.overwrite ?? false,
      replayGate: opts.replay !== false,
      useSnapshot: opts.sessionPin !== false,
      language,
      model: opts.model,
      targetOverride: opts.target,
      cwd,
      hubContext,
      updateAgentPrompt: opts.learnHubCodegenPrompt ?? false,
      teardown,
    }));
  } catch (e) {
    if (e instanceof SpecLockedError) {
      log.error(e.message);
      process.exit(2);
    }
    throw e;
  } finally {
    await teardown.run();
    disposeSignalHandlers();
  }
  if (!passed) process.exit(1);
}
