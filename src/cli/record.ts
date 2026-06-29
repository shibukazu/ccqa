import { Command } from "commander";
import { parseSpecPath } from "../store/index.ts";
import { runTrace, type RunTraceResult } from "./trace.ts";
import { runGenerate } from "./generate.ts";
import { addLanguageOption, addProfileOption, applyProfileFromOption, DEFAULT_LANGUAGE } from "./options.ts";
import { resolveCwd } from "./resolve-cwd.ts";
import { updateAgentPrompt } from "./update-agent-prompt.ts";
import type { FixMode } from "../diagnose/loop.ts";
import type { ValidationMode } from "../runtime/replay-validate.ts";
import type { Route } from "../types.ts";
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

export const recordCommand = addProfileOption(addLanguageOption(
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
      "After the trace finishes, ask Claude to refresh .ccqa/prompts/record.agent.md from a summary of the run.",
    )
    .option(
      "--cwd <path>",
      "Working directory containing the .ccqa/ tree (monorepo support). Defaults to the current directory.",
    ),
)).action(async (specPath: string, opts: RecordOptions) => {
  const { featureName, specName } = parseSpecPath(specPath);
  const language = opts.language ?? DEFAULT_LANGUAGE;

  if (opts.skipTrace && opts.skipCodegen) {
    log.error("--skip-trace and --skip-codegen cannot be combined; nothing would run");
    process.exit(2);
  }

  // Trace drives a real browser and resolves the spec's ${VAR} (login URL,
  // credentials) against process.env, so the profile (or default .env) must be
  // merged first.
  await applyProfileFromOption(opts.profile, resolveCwd(opts.cwd));

  let traceResult: RunTraceResult | null = null;
  if (!opts.skipTrace) {
    traceResult = await runTrace(featureName, specName, opts.model, opts.validationMode ?? "lenient", language);
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
      const cwd = resolveCwd(opts.cwd);
      log.blank();
      await updateAgentPrompt({
        mode: "record",
        runSummary: buildRecordRunSummary(featureName, specName, traceResult),
        cwd,
        ...(opts.model ? { model: opts.model } : {}),
        ...(language ? { language } : {}),
      });
    }
  }
});

/**
 * Compact summary of the trace pass for the record agent-prompt refresh:
 * per-step title / action / observation / status. The route steps already
 * carry the assistant's own framing of what happened — perfect input for
 * "what should I remember next time".
 */
function buildRecordRunSummary(featureName: string, specName: string, t: RunTraceResult): string {
  const header = `## ${featureName}/${specName} — ${t.route.status}\nActions: ${t.actionsKept} kept / ${t.actionsRecorded} recorded`;
  const steps = t.route.steps.length === 0
    ? "(no route steps recorded)"
    : t.route.steps.map((s: Route["steps"][number]) =>
        [
          `### ${s.title} (${s.status})`,
          `- action: ${oneLineSummary(s.action)}`,
          `- observation: ${oneLineSummary(s.observation)}`,
          ...(s.reason ? [`- reason: ${oneLineSummary(s.reason)}`] : []),
        ].join("\n"),
      ).join("\n\n");
  return `${header}\n\n${steps}`;
}

function oneLineSummary(s: string): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > 240 ? flat.slice(0, 240) + "…" : flat || "(none)";
}
