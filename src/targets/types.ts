import type { TestSpec } from "../spec/yaml-schema.ts";
import type { RecordedAction } from "../ir/types.ts";
import type { Conventions, ResourceRef, TargetConfig } from "../config/project-config.ts";
import type { HubContext } from "../cli/hub-conn.ts";
import type { RunTeardown } from "../cli/run-teardown.ts";
import type { FixMode } from "../diagnose/loop.ts";
import type { SpecRef } from "../store/index.ts";
import type { GroupLookup } from "../run/serial-groups.ts";
import type { GuidanceKind } from "../prompts/prompt-names.ts";
import type { ReportCoverage, ReportSpecResult } from "../report/schema.ts";

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
  /**
   * Whether this target's generated tests capture per-step screenshots (the
   * `ccqa/step-evidence` calls its emitter injects). Absent means they don't:
   * `ccqa run` then leaves `CCQA_EVIDENCE_DIR` unset for the target and puts
   * `reason` on every row, so the report can say why there are no screenshots
   * instead of rendering an empty section.
   *
   * Only consulted for external (runner-driven) targets — the built-in
   * agent-browser paths capture their evidence themselves.
   */
  stepEvidence?: StepEvidenceSupport;
  /**
   * How `ccqa run --coverage` reaches the browser this target drives.
   * Required, never optional: an author adding a target must answer, because
   * a forgotten answer is indistinguishable from "no browser" and the row
   * would then claim the spec reached nothing.
   */
  browserCoverage: BrowserCoverageDecl;
  /**
   * Whether this target emits a call that decides a `judgeByLlm` step.
   * Required, never optional, for the same reason as `browserCoverage`: an
   * omitted answer would read as "yes" and let a claim through unjudged, and
   * a claim nobody decides is a test that passes without testing. `reason` is
   * what the spec's author is told when one is refused.
   */
  judgeSteps: CapabilitySupport;
  /**
   * The guidance-prompt kind this target learns under (`<kind>.user` /
   * `<kind>.agent`). Set only by LLM-generating targets (playwright, runn):
   * `ccqa generate --learn-hub-codegen-prompt` refreshes `<guidanceKind>.agent`
   * from the run. Absent means the target has no learned generation prompt
   * (agent-browser's codegen is mechanical); the CLI then declines the flag.
   */
  guidanceKind?: GuidanceKind;
}

/** A yes/no capability whose "no" has to explain itself, on the row or in the refusal. */
export type CapabilitySupport = { supported: true } | { supported: false; reason: string };

export type StepEvidenceSupport = CapabilitySupport;

/**
 * A target's answer to "where is your browser?".
 *
 * All of acquisition — the spec cookie, V8's counters, taking them before
 * navigations — is one shared CDP engine, so `cdp` only obliges the target to
 * produce the endpoint: the handful of lines that genuinely differ per target
 * (agent-browser asks its CLI; playwright has ccqa launch the server its tests
 * then connect to). `none` obliges it to explain, and the reason lands on every
 * report row as `coverageUnavailable`, so a lazy "none" is visible to the user
 * rather than a silent gap.
 */
export type BrowserCoverageDecl =
  | { browser: "cdp"; cdpEndpoint(ctx: CdpEndpointContext): Promise<CdpBrowserHandle> }
  | { browser: "none"; reason: string };

export interface CdpEndpointContext {
  cwd: string;
  featureName: string;
  specName: string;
  /** The driver session the caller already owns, for targets that have one (agent-browser). */
  driverSession?: string;
}

/** Where a target's browser answers CDP, at acquisition and later. */
export interface CdpAddress {
  /** `host:port`, an `http://` endpoint, or a ws URL of the DevTools socket. */
  cdpUrl: string;
  /**
   * Where the browser is *now*. A target whose browser can be replaced under
   * the run — agent-browser relaunches a session's on a port the OS picks —
   * answers with the current socket, which is what lets a dropped measurement
   * reattach instead of retrying an address nothing listens on. Absent when
   * the address the target handed out is the address for good.
   */
  currentCdpUrl?(): Promise<string>;
}

/** A reachable browser, plus whatever the target's own tooling needs to use it. */
export interface CdpBrowserHandle extends CdpAddress {
  /** Extra environment for the spec's process (e.g. where to connect). */
  env?: Record<string, string>;
  /** Amends the spec's run command so its tooling uses this browser. */
  amendCommand?(command: string): string;
  /** Must be idempotent: it runs from the runner's `finally` *and* the signal teardown. */
  dispose(): Promise<void>;
}

/**
 * Knobs for the target's own verify/fix loop, straight from the CLI flags.
 * How they're interpreted is target-specific (agent-browser: the vitest +
 * diagnose auto-fix loop; runCommand targets later: a bounded regenerate
 * loop).
 */
export interface FixOptions {
  /** `--auto-fix-max-retries`: fix attempts after a failing verification run. */
  maxRetries: number;
  /** `--auto-fix`: whether fixes may be applied without confirmation. */
  mode: FixMode;
  /**
   * `--no-session-pin` sets this false: recorder-backed targets then skip
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
  /**
   * The command's signal teardown. A target that pins a browser session
   * registers it here instead of installing its own signal handler: the
   * command owns the exit, and a second handler racing it could exit before
   * the command's own finalizers (e.g. sealing a hub run) had finished.
   * Absent only for callers with no teardown, which then get no signal-time
   * reap.
   */
  teardown?: RunTeardown;
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
  /**
   * The run's signal teardown. A runner that acquires something a `finally`
   * cannot protect — node bypasses `finally` on an unhandled signal, and a
   * coverage browser handle owns a process and a file in the consumer's repo —
   * registers its disposal here.
   */
  teardown?: RunTeardown;
  /** Max specs executed in parallel. */
  concurrency: number;
  /**
   * A spec's serial-group names, from `.ccqa/config.yaml`. A runner executing
   * specs in parallel must not overlap two that share one — see `runPool`'s
   * `resources` option.
   */
  resources: GroupLookup;
  model?: string;
  language?: string;
  /** Registry id of the target being executed, for log labels and messages. */
  targetId: string;
  /** The target's resolved config block — runCommand runners read `runCommand` here. */
  targetConfig: TargetConfig;
  /**
   * Resolved from the plugin's `stepEvidence` (absent ⇒ unsupported). Runners
   * point the child at a per-spec `CCQA_EVIDENCE_DIR` only when supported.
   */
  stepEvidence: StepEvidenceSupport;
  /**
   * Called with each spec's row the moment it finishes, before the runner
   * returns. This is what makes an external run interrupt-safe and streams it
   * to a hub under `--report-to-hub`: a runner that batches its rows until the
   * end loses every one of them to a CI cancel. Rows are still returned from
   * `run()` for the final report, so the callback is purely incremental.
   */
  onSpecComplete: (row: ReportSpecResult) => Promise<void>;
  /** The target's `browserCoverage` declaration, passed through verbatim. */
  browserCoverage: BrowserCoverageDecl;
  /**
   * Set by `ccqa run --coverage`. A runner brackets each spec with
   * `beginSpec`/`collect`, and between them attaches the acquisition engine
   * to the browser the target's `cdpEndpoint` names — the collection waits
   * for in-flight pushes, so it must not run while the spec still is.
   *
   * Structural, so this module does not have to know the coverage subsystem's
   * class and a runner test does not have to stand up its HTTP sink.
   */
  coverage?: CoverageCollector;
}

/**
 * Executes previously generated tests for a set of specs. Rows use the report
 * schema's per-spec shape (`ReportSpecResult`) — the currency
 * `src/run/pipeline.ts` merges into report.json and pushes to the hub — so a
 * runner's results plug into the pipeline without translation.
 */
export interface TestRunner {
  run(specs: readonly SpecRef[], opts: RunnerOptions): Promise<ReportSpecResult[]>;
}

/**
 * The half of a coverage session a runner uses. See `src/coverage/session.ts`.
 *
 * `beginSpec` may wait before it answers — a spec acting as an identity another
 * spec just released has to let the boundary go quiet first — so it brackets
 * the spec rather than only describing it. `armBrowser` attaches the shared
 * acquisition engine to the browser named by the target's `cdpEndpoint`.
 * `collect` resolves undefined when the run streams to the hub inbox
 * (ADR-0022): the stream is the record there, so the row carries no coverage.
 */
export interface CoverageCollector {
  beginSpec(ref: SpecRef): Promise<void>;
  armBrowser(ref: SpecRef, browser: CdpAddress, artifactsDir: string): Promise<{ stop(): Promise<void> }>;
  collect(ref: SpecRef, artifactsDir: string): Promise<ReportCoverage | undefined>;
}
