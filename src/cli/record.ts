import { Command } from "commander";
import { parseSpecPath } from "../store/index.ts";
import { runTrace } from "./trace.ts";
import { runGenerate } from "./generate.ts";
import { addLanguageOption, DEFAULT_LANGUAGE } from "./options.ts";
import type { FixMode } from "../diagnose/loop.ts";
import type { ValidationMode } from "../runtime/replay-validate.ts";
import * as log from "./logger.ts";

const AUTO_FIX_MODES = ["interactive", "auto", "skip"] as const;
type AutoFixMode = (typeof AUTO_FIX_MODES)[number];

const VALIDATION_MODES = ["lenient", "strict"] as const;

interface RecordOptions {
  model?: string;
  language?: string;
  validationMode?: ValidationMode;
  autoFix?: AutoFixMode;
  maxRetries?: string;
  force?: boolean;
  snapshot?: boolean;
  skipTrace?: boolean;
  skipCodegen?: boolean;
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

export const recordCommand = addLanguageOption(
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
    .option("--skip-codegen", "Run only the trace step (do not generate test.spec.ts)"),
).action(async (specPath: string, opts: RecordOptions) => {
  const { featureName, specName } = parseSpecPath(specPath);
  const language = opts.language ?? DEFAULT_LANGUAGE;

  if (opts.skipTrace && opts.skipCodegen) {
    log.error("--skip-trace and --skip-codegen cannot be combined; nothing would run");
    process.exit(2);
  }

  if (!opts.skipTrace) {
    await runTrace(featureName, specName, opts.model, opts.validationMode ?? "lenient", language);
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
});
