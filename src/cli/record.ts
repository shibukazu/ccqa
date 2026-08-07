import { withUsageErrors } from "./usage-errors.ts";
import { Command } from "commander";
import { parseSpecPath, readSpecFile } from "../store/index.ts";
import { acquireSpecLock, SpecLockedError } from "../store/spec-lock.ts";
import { parseTestSpec } from "../spec/parser.ts";
import { loadProjectConfig } from "../config/project-config.ts";
import { resolveTarget } from "../targets/registry.ts";
import { currentReportCost } from "../report/run-cost.ts";
import { emptySpecRow } from "../report/spec-row.ts";
import { runTrace, type RunTraceResult } from "./trace.ts";
import { parseAutoFixFlag, resolveTargetOrExit, runGenerate, toFixMode, type AutoFixMode } from "./generate.ts";
import { addHubOptions, addLanguageOption, addProfileOption, applyProfileFromOption, DEFAULT_LANGUAGE } from "./options.ts";
import { resolveCwd } from "./resolve-cwd.ts";
import { resolveProject } from "./resolve-project.ts";
import { resolveHubClient, type HubContext } from "./hub-conn.ts";
import {
  needsHubConnection,
  openHubRun,
  requireReportToHubConnection,
  sealHubRun,
  type HubRunPush,
} from "./open-hub-run.ts";
import { createRunTeardown, installTeardownSignalHandlers } from "./run-teardown.ts";
import { updateAgentPrompt } from "./update-agent-prompt.ts";
import type { ValidationMode } from "../runtime/replay-validate.ts";
import type { Locator, ParsedStatusLine, RecordedAction } from "../types.ts";
import * as log from "./logger.ts";
import { withCostReporting } from "./cost-line.ts";

const VALIDATION_MODES = ["lenient", "strict"] as const;

interface RecordOptions {
  model?: string;
  language?: string;
  instruction?: string;
  hubProfile?: string;
  traceValidation?: ValidationMode;
  autoFix?: AutoFixMode;
  autoFixMaxRetries?: string;
  timeout?: number;
  overwrite?: boolean;
  sessionPin?: boolean;
  traceOnly?: boolean;
  learnHubTracePrompt?: boolean;
  reportToHub?: boolean;
  cwd?: string;
  hubUrl?: string;
  hubToken?: string;
  hubHeader?: string[];
  project?: string;
}

export const recordCommand = addHubOptions(addProfileOption(addLanguageOption(
  new Command("record")
    .argument(
      "<feature/spec>",
      "Spec id in '<feature>/<spec>' form (resolves to .ccqa/features/<feature>/test-cases/<spec>/)",
    )
    .description(
      "Record a test from a spec: run agent-browser to collect actions (trace), then compile them " +
        "into runnable code via the spec's target (generate) — a vitest test.spec.ts for agent-browser, " +
        "a @playwright/test spec for the playwright target. Recording-backed targets only; spec-input " +
        "targets like runn have no trace step (use `ccqa generate`), and agent-browser live specs need no recording.",
    )
    .optionsGroup("How to record:")
    .option(
      "-m, --model <name>",
      "Claude model alias ('sonnet'|'opus'|'haiku') or full ID. Overrides CCQA_MODEL.",
    )
    .option(
      "--instruction <text>",
      "Extra guidance for the recording agent — e.g. the drift audit's finding when re-recording a drifted spec.",
    )
    .option(
      "--trace-validation <mode>",
      "What to do with actions that fail post-trace validation: 'lenient' (default) tags them; 'strict' drops them.",
      (raw): ValidationMode => {
        if ((VALIDATION_MODES as readonly string[]).includes(raw)) return raw as ValidationMode;
        throw new Error(`--trace-validation must be one of ${VALIDATION_MODES.join(" | ")}`);
      },
      "lenient" as ValidationMode,
    )
    .option(
      "--auto-fix <mode>",
      "Auto-fix behaviour during script generation: 'interactive' (default, prompt y/N; declines on non-TTY), 'auto' (apply without prompt, for CI), 'skip' (agent-browser: apply only high-confidence fixes; external targets like playwright/runn: no fix pass at all).",
      parseAutoFixFlag,
      "interactive" as AutoFixMode,
    )
    .option("--auto-fix-max-retries <n>", "Maximum number of auto-fix retries", "3")
    .option(
      "--timeout <seconds>",
      "Abort the recording after this many seconds, wherever it is (trace, generate, auto-fix): reap the browser session, seal the open hub run (--report-to-hub) with a 'timed out' note, and exit 124. Prefer this over wrapping the command in an external `timeout`, whose SIGTERM may never reach this process.",
      parseTimeoutSeconds,
    )
    .option("--trace-only", "Stop after the trace step; do not generate test code")
    .option(
      "--no-session-pin",
      "Don't pin AGENT_BROWSER_SESSION / capture page snapshots after a failure (debug toggle)",
    )
    .optionsGroup("What to do with the result:")
    .option("--overwrite", "Replace an existing test.spec.ts without warning")
    .option(
      "--report-to-hub",
      "Leave a run (kind: record) on the hub saying this spec was recorded and what the recording spent on Claude, so a budget summed over the hub's runs sees it. It advances no ledger: a recording verifies nothing.",
    )
    .optionsGroup("Learning:")
    .option(
      "--learn-hub-trace-prompt",
      "After the trace finishes, ask Claude to refresh the \"record.agent\" prompt on the hub from a summary of the run. Requires a hub connection.",
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
)))
  .action(
    withUsageErrors(async (specPath: string, opts: RecordOptions) => {
      // record calls Claude several times (browser trace, codegen cleanup, one
      // diagnosis per auto-fix retry). Report the total, not each piece.
      await withCostReporting("record", () => runRecord(specPath, opts));
    }),
  );

async function runRecord(specPath: string, opts: RecordOptions): Promise<void> {
  const { featureName, specName } = parseSpecPath(specPath);
  const language = opts.language ?? DEFAULT_LANGUAGE;

  const cwdForProfile = resolveCwd(opts.cwd);

  // Resolve the spec's generation target up front: an input:"spec" target has
  // no record phase at all, so fail fast — before any profile or browser
  // work — and point at `ccqa generate` instead.
  const spec = parseTestSpec(await readSpecFile(featureName, specName, cwdForProfile));
  const config = await loadProjectConfig(cwdForProfile);
  const target = resolveTargetOrExit(() => resolveTarget(spec, config));
  if (target.input === "spec") {
    log.error(
      `target "${target.id}" does not use a browser recording — run 'ccqa generate ${featureName}/${specName}' instead`,
    );
    process.exit(2);
  }

  // Trace drives a real browser and resolves the spec's ${VAR} (login URL,
  // credentials) against process.env, so the profile (or default .env) must be
  // merged first. Project resolution (for scoping the hub lookup) only
  // happens when --hub-profile is actually given.
  const project = opts.hubProfile !== undefined ? resolveProject(opts) : undefined;
  if (opts.hubProfile !== undefined) {
    await applyProfileFromOption({
      profile: opts.hubProfile,
      project: project!,
      cwd: cwdForProfile,
      hubUrl: opts.hubUrl,
      hubToken: opts.hubToken,
      hubHeader: opts.hubHeader,
    });
  } else {
    await applyProfileFromOption({ profile: undefined, project: "", cwd: cwdForProfile });
  }

  // Compose HubContext by hand (not via resolveHubContext) — project is
  // resolved via the existing `resolveProject`, and mixing in the throwing
  // resolver would change the error mode for an invalid --project from
  // process.exit(2) to an uncaught throw. The project scope matters whenever
  // a hub is configured (prompt lookups, the perspectives auto-update), not
  // only when --hub-profile asked for hub variables.
  const hubClientForTrace = resolveHubClient({ hubUrl: opts.hubUrl, hubToken: opts.hubToken, hubHeader: opts.hubHeader });
  const hubProject = project ?? (hubClientForTrace !== null ? resolveProject(opts) : undefined);
  const hubContext: HubContext | null = hubClientForTrace && hubProject ? { hub: hubClientForTrace, project: hubProject } : null;

  // Checked before the browser runs: a recording that cannot write back what
  // it learned should say so first, not after the expensive part.
  if (opts.learnHubTracePrompt && hubContext === null) {
    log.error(needsHubConnection("--learn-hub-trace-prompt"));
    process.exit(2);
  }
  // Checked here rather than left to `openHubRun`: that call sits behind the
  // spec lock, and the usage error it raises exits without releasing it.
  const pushConn = opts.reportToHub ? requireReportToHubConnection(hubContext) : null;

  // Hold the spec lock across trace + generate: a concurrent record/generate
  // of the same spec would interleave ir.json and output writes. runGenerate
  // re-acquires re-entrantly inside the same process.
  const releaseLock = await acquireSpecLock(featureName, specName, "record", cwdForProfile).catch(
    (e: unknown) => {
      if (e instanceof SpecLockedError) {
        log.error(e.message);
        process.exit(2);
      }
      throw e;
    },
  );

  // Opened after the lock, so a spec another job holds costs no orphan run,
  // and before the trace, so a recording that dies still leaves its spend.
  const push = pushConn ? await openHubRun("record", pushConn, cwdForProfile, opts.hubProfile) : null;
  if (push) log.info(`hub: record run opened (${push.runId})`);

  // Node skips `finally` on a signal, and a CI `timeout` sends SIGTERM — so a
  // hung recording would otherwise leave its run `running` with no spend, the
  // one case the flag exists for. Both paths seal through the teardown, so the
  // `process.exit` below cannot cut off a PATCH already on the wire.
  let recorded = false;
  let sealed = true;
  // Which spec step the trace is in, and what (if anything) is aborting the
  // process — together they turn a bare status:"failed" hub row into
  // "terminated by signal (SIGTERM) during step-NN" or "timed out after 900s
  // during step-NN", the difference between a diagnosable death and a mystery.
  // Signal and --timeout both die through this one seal-with-note path.
  let tracingStep: string | undefined;
  let abortCause: string | undefined;
  const teardown = createRunTeardown();
  teardown.onFinalize(async () => {
    if (!push) return;
    sealed = await sealRecordPush(
      push,
      featureName,
      specName,
      recorded,
      abortCause !== undefined ? abortNote(abortCause, tracingStep) : undefined,
    );
  });
  const disposeSignalHandlers = installTeardownSignalHandlers(teardown, (sig) => {
    abortCause = `terminated by signal (${sig})`;
  });

  // The deadline is record's own `timeout(1)`: a CI wrapper's SIGTERM lands on
  // the package-manager shim, which does not reliably forward it here, so the
  // graceful seal above never ran. Expiry takes the same road as a signal —
  // name the cause, run the teardown (seal the hub row, reap the browser) —
  // then exits 124, the code an external `timeout` made conventional. Armed
  // here so it covers the whole expensive phase: trace, learning, generate
  // and the auto-fix loop's browser replays.
  let deadline: NodeJS.Timeout | undefined;
  if (opts.timeout !== undefined) {
    const seconds = opts.timeout;
    deadline = setTimeout(() => {
      abortCause = `timed out after ${seconds}s`;
      log.error(`--timeout: ${abortNote(abortCause, tracingStep)}`);
      void teardown.run().finally(() => process.exit(124));
    }, seconds * 1000);
    deadline.unref();
  }

  try {
    let generated = true;
    try {
      const traceResult = await runTrace(featureName, specName, opts.model, opts.traceValidation ?? "lenient", language, {
        cwd: cwdForProfile,
        hubContext,
        ...(opts.instruction ? { instruction: opts.instruction } : {}),
        onStep: (stepId) => {
          tracingStep = stepId;
        },
      });
      // The trace finished: a later signal (during generate) is no longer
      // "during step-NN" — that would name a step that completed fine.
      tracingStep = undefined;
      log.blank();

      // Learn from the trace before generate runs, not after: the flag's
      // contract is "after the trace finishes", and the generate/auto-fix half
      // (vitest browser replays, diagnose calls) has many ways to die that
      // must not take a completed trace's learnings with it.
      await learnFromTrace({
        enabled: opts.learnHubTracePrompt === true,
        featureName,
        specName,
        traceResult,
        hubContext,
        ...(opts.model ? { model: opts.model } : {}),
        ...(language ? { language } : {}),
      });

      if (!opts.traceOnly) {
        generated = (await runGenerate(featureName, specName, {
          maxRetries: parseInt(opts.autoFixMaxRetries ?? "3", 10),
          fixMode: toFixMode(opts.autoFix ?? "interactive"),
          force: opts.overwrite ?? false,
          useSnapshot: opts.sessionPin !== false,
          language,
          model: opts.model,
          cwd: cwdForProfile,
          hubContext,
          teardown,
        })).passed;
      }
    } finally {
      await releaseLock();
    }

    recorded = generated;
  } finally {
    // Disarm before the teardown seals: a run completing at the buzzer must
    // not be shot by its own deadline mid-seal.
    if (deadline !== undefined) clearTimeout(deadline);
    await teardown.run();
    disposeSignalHandlers();
  }

  // After the seal: `process.exit` would skip it, losing exactly the spend an
  // exhausted auto-fix loop is most expensive for. A run left open on the hub
  // is the worse outcome of the two, so it decides the code.
  if (!sealed) process.exit(2);
  if (!recorded) process.exit(1);
}

/** `--timeout <seconds>`: a positive whole number of seconds. */
export function parseTimeoutSeconds(raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || Math.floor(n) !== n) {
    throw new Error(`--timeout must be a positive integer number of seconds, got "${raw}"`);
  }
  return n;
}

/**
 * The one line an aborted recording leaves on its hub row: what ended it
 * ("terminated by signal (SIGTERM)", "timed out after 900s") plus the spec
 * step that was tracing, when one was in flight. The signal handlers and the
 * --timeout deadline both seal through this, so every abort dies with the
 * same shape of reason.
 */
export function abortNote(cause: string, tracingStep?: string): string {
  return `${cause}${tracingStep !== undefined ? ` during ${tracingStep}` : ""}`;
}

export interface LearnFromTraceArgs {
  /** The caller's `--learn-hub-trace-prompt`. */
  enabled: boolean;
  featureName: string;
  specName: string;
  /** Null when no browser trace ran (or one died before producing a result). */
  traceResult: RunTraceResult | null;
  hubContext: HubContext | null;
  model?: string;
  language?: string;
}

/**
 * The rule for `--learn-hub-trace-prompt`: a browser trace ran → learn from
 * it; no trace → stay silent. `runRecord` calls this immediately after the
 * trace, before generate — sequencing it after the generate/auto-fix half
 * (as record once did) let any death there discard a completed trace's
 * learnings. Returns whether the refresh fired, and takes the updater as a
 * seam so the rule is testable without a browser.
 */
export async function learnFromTrace(
  args: LearnFromTraceArgs,
  update: typeof updateAgentPrompt = updateAgentPrompt,
): Promise<boolean> {
  if (!args.enabled || args.traceResult === null) return false;
  log.blank();
  await update({
    kind: "record",
    flag: "--learn-hub-trace-prompt",
    runSummary: buildRecordRunSummary(args.featureName, args.specName, args.traceResult),
    hubContext: args.hubContext,
    ...(args.model !== undefined ? { model: args.model } : {}),
    ...(args.language !== undefined ? { language: args.language } : {}),
  });
  return true;
}

/**
 * Close the record run with the one row this command produced, answering
 * whether it closed. One spec is recorded per invocation, so one row is the
 * whole run — enough for the runs list to say what the money bought.
 *
 * `failureNote` (e.g. "terminated by signal (SIGTERM) during step-03") rides
 * in the row's `failureLogExcerpt` — the field a failed `ccqa run` row already
 * uses for its failure text — so the hub says why a recording died instead of
 * a bare status:"failed". Ignored on a successful recording.
 */
export async function sealRecordPush(
  push: HubRunPush,
  featureName: string,
  specName: string,
  recorded: boolean,
  failureNote?: string,
): Promise<boolean> {
  return sealHubRun(push, {
    rows: [
      {
        ...emptySpecRow({
          feature: featureName,
          spec: specName,
          title: null,
          status: recorded ? "passed" : "failed",
        }),
        ...(!recorded && failureNote ? { failureLogExcerpt: failureNote } : {}),
      },
    ],
    reportMeta: { git: { head: push.gitHead, base: null }, cost: currentReportCost() },
  });
}

/**
 * Compact summary of the trace pass for the record agent-prompt refresh.
 * Steps are reconstructed from the trace's status-line protocol (STEP_START
 * gives the title, STEP_DONE / ASSERTION_FAILED / STEP_SKIPPED the outcome),
 * and each step carries its per-action observations plus the **concrete kept
 * commands** — the selectors that actually survived scrub / dedup /
 * validation. The record playbook is told to record canonical selectors, so
 * it needs those exact tokens; the prose alone doesn't carry them. The
 * header's kept/recorded totals flag how much the run thrashed through
 * selectors overall.
 */
export function buildRecordRunSummary(featureName: string, specName: string, t: RunTraceResult): string {
  const header = `## ${featureName}/${specName} — ${t.status}\nActions: ${t.actionsKept} kept / ${t.actionsRecorded} recorded`;
  const steps = collectStepSummaries(t.statusLines);
  if (steps.length === 0) return `${header}\n\n(no step status lines recorded)`;
  const commandsByStep = groupCommandsByStep(t.actions);
  const observationsByStep = groupObservationsByStep(t.actions);
  const unstableByStep = countUnstableByStep(t.actions);
  const body = steps.map((s) => {
    const cmds = commandsByStep.get(s.stepId) ?? [];
    const observations = observationsByStep.get(s.stepId) ?? [];
    const churn = t.churnByStep.get(s.stepId);
    const dropped = churn ? churn.recorded - churn.kept : 0;
    const redundant = churn?.redundant ?? 0;
    const unstable = unstableByStep.get(s.stepId) ?? 0;
    return [
      `### ${s.stepId} — ${oneLineSummary(s.title)} (${s.status})`,
      ...(s.detail ? [`- result: ${oneLineSummary(s.detail)}`] : []),
      ...(observations.length > 0 ? [`- observations: ${observations.map(oneLineSummary).join(" ; ")}`] : []),
      // Surface churn above the commands so the learner reads "this step
      // thrashed" before it sees which selector survived. Three kinds:
      // dropped = failed selector attempts; redundant = same field reached
      // via 2+ selectors that both stuck; unstable = kept-but-flaky
      // selectors it must NOT record as canonical.
      ...(dropped > 0 ? [`- churn: ${churn!.recorded} attempts → ${churn!.kept} kept (${dropped} dropped)`] : []),
      ...(redundant > 0 ? [`- redundant: ${redundant} field(s) entered via 2+ selectors (kept both — record one canonical selector)`] : []),
      ...(unstable > 0 ? [`- replay-unstable: ${unstable} kept command(s) marked [unstable] — do NOT record these as canonical; prefer a more stable locator even if it costs one more probe`] : []),
      ...(cmds.length > 0 ? [`- kept commands: ${cmds.join(" ; ")}`] : []),
    ].join("\n");
  }).join("\n\n");
  return `${header}\n\n${body}`;
}

interface StepSummary {
  stepId: string;
  title: string;
  status: "DONE" | "FAILED" | "SKIPPED" | "NO_STATUS";
  /** Detail of the terminal status line (what was verified / failure reason). */
  detail?: string;
}

/**
 * Fold the ordered status lines into one entry per step: STEP_START opens
 * the entry (its detail is the step title); the terminal line sets the
 * outcome. A terminal line for a step that never emitted STEP_START still
 * gets an entry so its outcome isn't silently lost.
 */
function collectStepSummaries(lines: ParsedStatusLine[]): StepSummary[] {
  const byId = new Map<string, StepSummary>();
  const ordered: StepSummary[] = [];
  const ensure = (stepId: string, title: string): StepSummary => {
    let entry = byId.get(stepId);
    if (!entry) {
      entry = { stepId, title, status: "NO_STATUS" };
      byId.set(stepId, entry);
      ordered.push(entry);
    }
    return entry;
  };
  for (const line of lines) {
    if (!line.stepId || line.type === "RUN_COMPLETED") continue;
    if (line.type === "STEP_START") {
      ensure(line.stepId, line.detail);
      continue;
    }
    const entry = ensure(line.stepId, "(untitled)");
    entry.status = line.type === "STEP_DONE" ? "DONE" : line.type === "ASSERTION_FAILED" ? "FAILED" : "SKIPPED";
    if (line.detail) entry.detail = line.detail;
  }
  return ordered;
}

/** Group each kept action's `action selector` form under its stepId. */
function groupCommandsByStep(actions: RecordedAction[]): Map<string, string[]> {
  const byStep = new Map<string, string[]>();
  for (const a of actions) {
    if (!a.stepId) continue;
    const list = byStep.get(a.stepId) ?? [];
    list.push(formatRecordedAction(a));
    byStep.set(a.stepId, list);
  }
  return byStep;
}

/**
 * Group per-action observations (snapshot / assert prose) under their stepId
 * — the trace's own record of what it verified at each step.
 */
function groupObservationsByStep(actions: RecordedAction[]): Map<string, string[]> {
  const byStep = new Map<string, string[]>();
  for (const a of actions) {
    if (!a.stepId || !a.observation) continue;
    const list = byStep.get(a.stepId) ?? [];
    list.push(a.observation);
    byStep.set(a.stepId, list);
  }
  return byStep;
}

/** Per-step count of kept-but-replay-unstable actions (the flaky selectors). */
function countUnstableByStep(actions: RecordedAction[]): Map<string, number> {
  const byStep = new Map<string, number>();
  for (const a of actions) {
    if (!a.stepId || !a.replayUnstable) continue;
    byStep.set(a.stepId, (byStep.get(a.stepId) ?? 0) + 1);
  }
  return byStep;
}

/**
 * One kept action as `action selector` (with the fill value or assert
 * type when present) — the canonical form the record playbook should reuse.
 * Unlike the live summary this keeps selectors verbatim: record learns
 * concrete per-spec selectors, so masking them would defeat the purpose.
 *
 * A replay-unstable action (kept in lenient mode but flagged because its
 * selector wasn't present on a fresh replay) is tagged `[unstable](<reason>)`
 * so the learner does NOT record its selector as canonical — the reason is the
 * teacher signal ("not present within Nms" = timing-fragile, not stable).
 */
function formatRecordedAction(a: RecordedAction): string {
  const parts: string[] = [a.action];
  if (a.index !== undefined) parts.push(String(a.index));
  const anchor = a.locator ? formatLocator(a.locator) : a.label;
  if (anchor) parts.push(anchor);
  if (a.value) parts.push(`= ${a.value}`);
  if (a.assert) parts.push(`(${a.assert})`);
  const line = oneLineSummary(parts.join(" "));
  return a.replayUnstable
    ? `${line} [unstable](${oneLineSummary(a.replayReason ?? "no reason")})`
    : line;
}

/** Verbatim locator form: raw selector for css, `by=value` for semantic ones. */
function formatLocator(locator: Locator): string {
  const name = locator.by === "role" && locator.name ? ` name=${locator.name}` : "";
  return locator.by === "css" ? locator.value : `${locator.by}=${locator.value}${name}`;
}

function oneLineSummary(s: string): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > 240 ? flat.slice(0, 240) + "…" : flat || "(none)";
}
