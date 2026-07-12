import { Command } from "commander";
import { parseSpecPath, readSpecFile } from "../store/index.ts";
import { acquireSpecLock, SpecLockedError } from "../store/spec-lock.ts";
import { parseTestSpec } from "../spec/parser.ts";
import { loadProjectConfig } from "../config/project-config.ts";
import { resolveTarget } from "../targets/registry.ts";
import { runTrace, type RunTraceResult } from "./trace.ts";
import { parseAutoFixFlag, runGenerate, toFixMode, type AutoFixMode } from "./generate.ts";
import { addHubOptions, addLanguageOption, addProfileOption, applyProfileFromOption, DEFAULT_LANGUAGE } from "./options.ts";
import { resolveCwd } from "./resolve-cwd.ts";
import { resolveProject } from "./resolve-project.ts";
import { resolveHubClient, type HubContext } from "./hub-conn.ts";
import { updateAgentPrompt } from "./update-agent-prompt.ts";
import type { ValidationMode } from "../runtime/replay-validate.ts";
import type { Locator, ParsedStatusLine, RecordedAction } from "../types.ts";
import * as log from "./logger.ts";

const VALIDATION_MODES = ["lenient", "strict"] as const;

interface RecordOptions {
  model?: string;
  language?: string;
  profile?: string;
  validationMode?: ValidationMode;
  autoFix?: AutoFixMode;
  maxRetries?: string;
  force?: boolean;
  snapshot?: boolean;
  skipTrace?: boolean;
  skipCodegen?: boolean;
  updateAgentPrompt?: boolean;
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
      "Record a deterministic test from a spec: run agent-browser to collect actions (trace), " +
        "then generate test.spec.ts with auto-fix retries (generate). " +
        "After recording, `ccqa run <feature/spec>` replays it under vitest (deterministic specs only — live specs do not need recording).",
    )
    .option(
      "-m, --model <name>",
      "Claude model alias ('sonnet'|'opus'|'haiku') or full ID. Overrides CCQA_MODEL.",
    )
    .option(
      "--validation-mode <mode>",
      "Post-trace validation behaviour: 'lenient' (default) tags failing actions; 'strict' drops them.",
      (raw): ValidationMode => {
        if ((VALIDATION_MODES as readonly string[]).includes(raw)) return raw as ValidationMode;
        throw new Error(`--validation-mode must be one of ${VALIDATION_MODES.join(" | ")}`);
      },
      "lenient" as ValidationMode,
    )
    .option(
      "--auto-fix <mode>",
      "Auto-fix behaviour during script generation: 'interactive' (default, prompt y/N), 'auto' (apply without prompt, for CI), 'skip' (never prompt, only apply high-confidence fixes).",
      parseAutoFixFlag,
      "interactive" as AutoFixMode,
    )
    .option("--max-retries <n>", "Maximum number of auto-fix retries", "3")
    .option("--force", "Overwrite an existing test.spec.ts without warning")
    .option(
      "--no-snapshot",
      "Don't pin AGENT_BROWSER_SESSION / capture page snapshots after a failure (debug toggle)",
    )
    .option("--skip-trace", "Skip the trace step and run codegen against an existing ir.json")
    .option("--skip-codegen", "Run only the trace step (do not generate test.spec.ts)")
    .option(
      "--update-agent-prompt",
      "After the trace finishes, ask Claude to refresh the \"record.agent\" prompt on the hub from a summary of the run. Requires a hub connection.",
    )
    .option(
      "--cwd <path>",
      "Working directory containing the .ccqa/ tree (monorepo support). Defaults to the current directory.",
    )
    .option(
      "--project <name>",
      "Project name for the hub. Defaults to the current directory's name.",
    ),
))).action(async (specPath: string, opts: RecordOptions) => {
  const { featureName, specName } = parseSpecPath(specPath);
  const language = opts.language ?? DEFAULT_LANGUAGE;

  if (opts.skipTrace && opts.skipCodegen) {
    log.error("--skip-trace and --skip-codegen cannot be combined; nothing would run");
    process.exit(2);
  }

  const cwdForProfile = resolveCwd(opts.cwd);

  // Resolve the spec's generation target up front: an input:"spec" target has
  // no record phase at all, so fail fast — before any profile or browser
  // work — and point at `ccqa generate` instead.
  const spec = parseTestSpec(await readSpecFile(featureName, specName, cwdForProfile));
  const target = resolveTarget(spec, await loadProjectConfig(cwdForProfile));
  if (target.input === "spec") {
    log.error(
      `target "${target.id}" does not use a browser recording — run 'ccqa generate ${featureName}/${specName}' instead`,
    );
    process.exit(2);
  }

  // Trace drives a real browser and resolves the spec's ${VAR} (login URL,
  // credentials) against process.env, so the profile (or default .env) must be
  // merged first. Project resolution (for scoping the hub lookup) only
  // happens when --profile is actually given.
  const project = opts.profile !== undefined ? resolveProject(opts) : undefined;
  if (opts.profile !== undefined) {
    await applyProfileFromOption({
      profile: opts.profile,
      project: project!,
      cwd: cwdForProfile,
      hubUrl: opts.hubUrl,
      hubToken: opts.hubToken,
      hubHeader: opts.hubHeader,
    });
  } else {
    await applyProfileFromOption({ profile: undefined, project: "", cwd: cwdForProfile });
  }

  // Compose HubContext by hand (not via resolveHubContext) — project here was
  // already resolved via the exiting `resolveProject`, and mixing in the
  // throwing resolver would change the error mode for an invalid --project
  // from process.exit(2) to an uncaught throw.
  const hubClientForTrace = resolveHubClient({ hubUrl: opts.hubUrl, hubToken: opts.hubToken, hubHeader: opts.hubHeader });
  const hubContext: HubContext | null = hubClientForTrace && project ? { hub: hubClientForTrace, project } : null;

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

  let traceResult: RunTraceResult | null = null;
  try {
    if (!opts.skipTrace) {
      traceResult = await runTrace(featureName, specName, opts.model, opts.validationMode ?? "lenient", language, {
        cwd: cwdForProfile,
        hubContext,
      });
      log.blank();
    }

    if (!opts.skipCodegen) {
      await runGenerate(featureName, specName, {
        maxRetries: parseInt(opts.maxRetries ?? "3", 10),
        fixMode: toFixMode(opts.autoFix ?? "interactive"),
        force: opts.force ?? false,
        useSnapshot: opts.snapshot !== false,
        language,
        model: opts.model,
        cwd: cwdForProfile,
        hubContext,
      });
    }
  } finally {
    await releaseLock();
  }

  if (opts.updateAgentPrompt) {
    if (traceResult === null) {
      log.warn("--update-agent-prompt is ignored when --skip-trace is set (no run summary available)");
    } else {
      log.blank();
      await updateAgentPrompt({
        mode: "record",
        runSummary: buildRecordRunSummary(featureName, specName, traceResult),
        hubContext,
        ...(opts.model ? { model: opts.model } : {}),
        ...(language ? { language } : {}),
      });
    }
  }
});

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
