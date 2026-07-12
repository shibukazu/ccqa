import type { TestSpec } from "../spec/yaml-schema.ts";
import type { RecordedAction } from "../ir/types.ts";
import type { Conventions, ResourceRef, TargetConfig } from "../config/project-config.ts";
import type { HubContext } from "../cli/hub-conn.ts";
import type { FixMode } from "../diagnose/loop.ts";
import type { SpecRef } from "../store/index.ts";
import type { ReportSpecResult } from "../report/schema.ts";

/**
 * Target plugin abstraction: a target turns a spec into runnable test code
 * (agent-browser today; Playwright / runn later) and optionally knows how to
 * execute what it generated. The CLI stays target-agnostic — it resolves the
 * plugin through the registry and dispatches on `input`, so adding a target
 * means registering a plugin, never editing command code.
 */

// The config layer owns these shapes (z.infer of `.ccqa/config.yaml`);
// re-exported here so plugins can type against the targets module alone.
export type { Conventions, ResourceRef, TargetConfig } from "../config/project-config.ts";
export type { SpecRef } from "../store/index.ts";

/**
 * What `generate` consumes:
 *  - "recording": the browser recording (IR) that `ccqa record` produced —
 *    frontend targets that compile a discovered page route into test code.
 *  - "spec": the spec alone; there is no record phase and `ccqa generate`
 *    is the generation entry point (e.g. backend runbook targets).
 */
export type TargetInput = "recording" | "spec";

export interface TargetPlugin {
  /** Registry id — what spec.yaml `target:` / config `defaultTarget` name. */
  id: string;
  input: TargetInput;
  /** Generate (and verify, when the target has a verification loop) test code. */
  generate(ctx: GenerateContext): Promise<GenerateResult>;
  /**
   * Absolute path of a previously generated artifact that `generate` would
   * overwrite, or null when there is none. The CLI uses this for its
   * interactive overwrite guard (`--force` skips the prompt); targets with
   * no overwrite hazard can omit the hook.
   */
  existingOutput?(ref: SpecRef, cwd: string): Promise<string | null>;
  /**
   * Executes previously generated tests under `ccqa run`. Absent means the
   * target is generate-only and the run pipeline records its specs as
   * skipped. (The built-in agent-browser target also leaves this unset — the
   * pipeline runs it through its dedicated det/live paths instead; see
   * src/run/target-dispatch.ts.) The pipeline only dispatches to a runner
   * when the target's config sets `runCommand`; runCommand targets can use
   * the shared `runCommandRunner` (src/targets/run-command-runner.ts).
   */
  runner?: TestRunner;
}

/**
 * Knobs for the target's own verify/fix loop, straight from the CLI flags.
 * How they're interpreted is target-specific (agent-browser: the vitest +
 * diagnose auto-fix loop; runCommand targets later: a bounded regenerate
 * loop).
 */
export interface FixOptions {
  /** `--max-retries`: fix attempts after a failing verification run. */
  maxRetries: number;
  /** `--auto-fix`: whether fixes may be applied without confirmation. */
  mode: FixMode;
  /**
   * `--no-snapshot` sets this false: recorder-backed targets then skip
   * pinning a browser session for post-failure page snapshots.
   */
  useSnapshot: boolean;
}

export interface GenerateContext {
  spec: TestSpec;
  /**
   * Raw spec.yaml text. LLM passes (the diagnose prompt today, generation
   * prompts later) want the verbatim file, not a re-serialization.
   */
  specYaml: string;
  featureName: string;
  specName: string;
  /** Project root — the directory holding `.ccqa/`. */
  cwd: string;
  /** Recorded IR; set iff the target's `input` is "recording". */
  recording?: RecordedAction[];
  /** Existing code assets generated tests should reuse (config `resources`). */
  resources: ResourceRef[];
  /** Style/convention guide inputs for generation (config `conventions`). */
  conventions: Conventions;
  /** Full per-target config block — also carries `outDir` / `runCommand`. */
  targetConfig: TargetConfig;
  language: string;
  model?: string;
  /** Hub connection for prompt bundles (learning overlays); null when unconfigured. */
  hub: HubContext | null;
  fix: FixOptions;
}

export interface GeneratedFile {
  /** Absolute path of the written file. */
  path: string;
  /** "test" = an executable test; "support" = a companion (page object etc.). */
  kind: "test" | "support";
}

/**
 * Outcome of a generate pass. `generate` writes its files itself — a
 * verification loop rewrites them in place, so returning payloads would go
 * stale — and `files` lists what landed on disk.
 */
export interface GenerateResult {
  files: GeneratedFile[];
  /** Short human-readable summary of what was generated. */
  summary: string;
  /** Notices worth keeping (the target already logged them during generate). */
  warnings: string[];
  /**
   * False when the target's verification (e.g. vitest + auto-fix) exhausted
   * its budget and the generated test still fails; the CLI maps that to a
   * non-zero exit. Targets without a verification step return true.
   */
  passed: boolean;
}

/** Options the run pipeline hands to a target's runner. */
export interface RunnerOptions {
  cwd: string;
  /** Directory report.json + evidence land in; runners may write artifacts under it. */
  reportDir: string;
  /** Max specs executed in parallel. */
  concurrency: number;
  model?: string;
  language?: string;
  /** Registry id of the target being executed, for log labels and messages. */
  targetId: string;
  /** The target's resolved config block — runCommand runners read `runCommand` here. */
  targetConfig: TargetConfig;
}

/**
 * Executes previously generated tests for a set of specs. Rows use the report
 * schema's per-spec shape (`ReportSpecResult`) — the currency
 * `src/run/pipeline.ts` merges into report.json and pushes to the hub — so a
 * runner's results plug into the pipeline without translation.
 */
export interface TestRunner {
  run(specs: SpecRef[], opts: RunnerOptions): Promise<ReportSpecResult[]>;
}
