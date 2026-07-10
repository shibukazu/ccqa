import { Command } from "commander";
import { parseSpecPath } from "../store/index.ts";
import { runTrace, type RunTraceResult } from "./trace.ts";
import { runGenerate } from "./generate.ts";
import { addHubOptions, addLanguageOption, addProfileOption, applyProfileFromOption, DEFAULT_LANGUAGE } from "./options.ts";
import { resolveCwd } from "./resolve-cwd.ts";
import { resolveProject } from "./resolve-project.ts";
import { resolveHubClient, type HubContext } from "./hub-conn.ts";
import { updateAgentPrompt } from "./update-agent-prompt.ts";
import type { FixMode } from "../diagnose/loop.ts";
import type { ValidationMode } from "../runtime/replay-validate.ts";
import type { Route, TraceAction } from "../types.ts";
import * as log from "./logger.ts";

const AUTO_FIX_MODES = ["interactive", "auto", "skip"] as const;
type AutoFixMode = (typeof AUTO_FIX_MODES)[number];

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

// Maps the user-facing `--auto-fix` 3-value flag to the internal `FixMode`:
//   interactive → prompt y/N when the auto-fix isn't high-confidence
//   auto        → never prompt; apply regardless of confidence (CI use)
//   skip        → never prompt and never apply; only apply when confidence is high
function toFixMode(autoFix: AutoFixMode): FixMode {
  switch (autoFix) {
    case "auto":
      return "auto";
    case "skip":
      return "non-interactive";
    case "interactive":
      return "interactive";
  }
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
      (raw): AutoFixMode => {
        if ((AUTO_FIX_MODES as readonly string[]).includes(raw)) return raw as AutoFixMode;
        throw new Error(`--auto-fix must be one of ${AUTO_FIX_MODES.join(" | ")}`);
      },
      "interactive" as AutoFixMode,
    )
    .option("--max-retries <n>", "Maximum number of auto-fix retries", "3")
    .option("--force", "Overwrite an existing test.spec.ts without warning")
    .option(
      "--no-snapshot",
      "Don't pin AGENT_BROWSER_SESSION / capture page snapshots after a failure (debug toggle)",
    )
    .option("--skip-trace", "Skip the trace step and run codegen against an existing actions.json")
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

  // Trace drives a real browser and resolves the spec's ${VAR} (login URL,
  // credentials) against process.env, so the profile (or default .env) must be
  // merged first. Project resolution (for scoping the hub lookup) only
  // happens when --profile is actually given.
  const cwdForProfile = resolveCwd(opts.cwd);
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

  let traceResult: RunTraceResult | null = null;
  if (!opts.skipTrace) {
    traceResult = await runTrace(featureName, specName, opts.model, opts.validationMode ?? "lenient", language, {
      cwd: cwdForProfile,
      hubContext,
    });
    log.blank();
  }

  if (!opts.skipCodegen) {
    const fixMode = toFixMode(opts.autoFix ?? "interactive");
    const useSnapshot = opts.snapshot !== false;
    await runGenerate(
      featureName,
      specName,
      parseInt(opts.maxRetries ?? "3", 10),
      fixMode,
      opts.force ?? false,
      useSnapshot,
      language,
      opts.model,
    );
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
 * Each step carries the assistant's own prose framing (action / observation)
 * plus the **concrete kept commands** for that step — the selectors that
 * actually survived scrub / dedup / validation. The record playbook is told
 * to record canonical selectors, so it needs those exact tokens; the prose
 * alone doesn't carry them. The header's kept/recorded totals flag how much
 * the run thrashed through selectors overall.
 */
export function buildRecordRunSummary(featureName: string, specName: string, t: RunTraceResult): string {
  const header = `## ${featureName}/${specName} — ${t.route.status}\nActions: ${t.actionsKept} kept / ${t.actionsRecorded} recorded`;
  const commandsByStep = groupCommandsByStep(t.actions);
  const unstableByStep = countUnstableByStep(t.actions);
  const steps = t.route.steps.length === 0
    ? "(no route steps recorded)"
    : t.route.steps.map((s: Route["steps"][number]) => {
        const id = s.stepId;
        const cmds = id ? commandsByStep.get(id) ?? [] : [];
        const churn = id ? t.churnByStep.get(id) : undefined;
        const dropped = churn ? churn.recorded - churn.kept : 0;
        const redundant = churn?.redundant ?? 0;
        const unstable = id ? unstableByStep.get(id) ?? 0 : 0;
        return [
          `### ${s.title} (${s.status})`,
          `- action: ${oneLineSummary(s.action)}`,
          `- observation: ${oneLineSummary(s.observation)}`,
          ...(s.reason ? [`- reason: ${oneLineSummary(s.reason)}`] : []),
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
  return `${header}\n\n${steps}`;
}

/** Group each kept action's `command selector` form under its stepId. */
function groupCommandsByStep(actions: TraceAction[]): Map<string, string[]> {
  const byStep = new Map<string, string[]>();
  for (const a of actions) {
    if (!a.stepId) continue;
    const list = byStep.get(a.stepId) ?? [];
    list.push(formatTraceAction(a));
    byStep.set(a.stepId, list);
  }
  return byStep;
}

/** Per-step count of kept-but-replay-unstable actions (the flaky selectors). */
function countUnstableByStep(actions: TraceAction[]): Map<string, number> {
  const byStep = new Map<string, number>();
  for (const a of actions) {
    if (!a.stepId || !a.replayUnstable) continue;
    byStep.set(a.stepId, (byStep.get(a.stepId) ?? 0) + 1);
  }
  return byStep;
}

/**
 * One kept action as `command selector` (with the fill/find value or assert
 * type when present) — the canonical form the record playbook should reuse.
 * Unlike the live summary this keeps selectors verbatim: record learns
 * concrete per-spec selectors, so masking them would defeat the purpose.
 *
 * A replay-unstable action (kept in lenient mode but flagged because its
 * selector wasn't present on a fresh replay) is tagged `[unstable](<reason>)`
 * so the learner does NOT record its selector as canonical — the reason is the
 * teacher signal ("not present within Nms" = timing-fragile, not stable).
 */
function formatTraceAction(a: TraceAction): string {
  const parts: string[] = [a.command];
  const anchor = a.selector ?? a.findValue ?? a.label;
  if (anchor) parts.push(anchor);
  if (a.value) parts.push(`= ${a.value}`);
  if (a.assertType) parts.push(`(${a.assertType})`);
  const line = oneLineSummary(parts.join(" "));
  return a.replayUnstable
    ? `${line} [unstable](${oneLineSummary(a.replayReason ?? "no reason")})`
    : line;
}

function oneLineSummary(s: string): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > 240 ? flat.slice(0, 240) + "…" : flat || "(none)";
}
