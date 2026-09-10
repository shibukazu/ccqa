import { specKey, type SpecRef } from "../store/index.ts";
import { AGENT_BROWSER_TARGET, type TestSpec } from "../spec/yaml-schema.ts";
import type { SpecCatalog } from "./spec-catalog.ts";
import type { GroupLookup } from "./serial-groups.ts";
import { targetConfigFor, type ProjectConfig, type TargetConfig } from "../config/project-config.ts";
import { registryFor, resolveTargetFrom } from "../targets/registry.ts";
import type {
  BrowserCoverageDecl,
  StepEvidenceSupport,
  TargetPlugin,
  TestRunner,
} from "../targets/types.ts";
import type { ReportSpecResult } from "../report/schema.ts";
import { emptySpecRow } from "../report/spec-row.ts";
import type { IncrementalReport } from "./incremental-report.ts";
import type { CoverageCollector } from "../targets/types.ts";
import type { RunTeardown } from "../cli/run-teardown.ts";
import * as log from "../cli/logger.ts";

/**
 * `ccqa run`'s target dispatch: split the enumerated specs by generation
 * target. Specs on the built-in agent-browser target keep the pipeline's
 * det/live paths; specs on external targets run through their plugin runner;
 * specs that cannot run at all become report rows (skipped / failed) instead
 * of silently dropping out of the run.
 */

/** A spec routed away from the det/live paths, with what its report row needs. */
export interface DispatchedSpec extends SpecRef {
  /** spec.yaml `title:`, carried into the report row. */
  title: string | null;
}

export interface ExternalTargetGroup {
  targetId: string;
  runner: TestRunner;
  targetConfig: TargetConfig;
  /** The plugin's `defaultTestPath`; see `RunnerOptions.defaultTestPath`. */
  defaultTestPath: string;
  /** Resolved from the plugin — absent on the plugin means "no step screenshots". */
  stepEvidence: StepEvidenceSupport;
  /** The target's required declaration, passed through verbatim. */
  browserCoverage: BrowserCoverageDecl;
  specs: DispatchedSpec[];
}

export interface UnrunnableSpec extends DispatchedSpec {
  reason: string;
  /** Target id for the report row; null when resolution failed before one was known. */
  targetId: string | null;
}

export interface TargetDispatch {
  /** Specs the pipeline's built-in det/live paths execute. */
  agentBrowser: SpecRef[];
  /** Runnable external targets (plugin has a runner AND config sets runCommand). */
  external: ExternalTargetGroup[];
  /** Specs on generate-only targets (no runner / no runCommand) → skipped rows. */
  skipped: UnrunnableSpec[];
  /** Specs whose target could not be resolved (unknown id, mode/session misuse) → failed rows. */
  unresolved: UnrunnableSpec[];
}

/**
 * Resolve each spec's target and group. A spec with no spec.yaml at all falls
 * through to the agent-browser path, whose runner surfaces the real error
 * itself. A spec whose file will not parse, or whose target resolution throws
 * (unknown target, agent-browser-only fields on another target), is recorded
 * per-spec instead of stopping the run. `resolve` is injectable so tests can
 * supply a registry of fake targets.
 */
/**
 * Resolve against a registry built once for the whole dispatch. A project that
 * declares targets in its config has them constructed from that config, and
 * doing that per spec would rebuild the same objects for every row of a run.
 */
function resolveTargetFor(config: ProjectConfig): (spec: TestSpec, c: ProjectConfig) => TargetPlugin {
  const registry = registryFor(config);
  return (spec, c) => resolveTargetFrom(spec, c, registry);
}

export function groupSpecsByTarget(
  specs: readonly SpecRef[],
  catalog: SpecCatalog,
  config: ProjectConfig,
  resolve: (spec: TestSpec, config: ProjectConfig) => TargetPlugin = resolveTargetFor(config),
): TargetDispatch {
  const agentBrowser: SpecRef[] = [];
  const externalById = new Map<string, ExternalTargetGroup>();
  const skipped: UnrunnableSpec[] = [];
  const unresolved: UnrunnableSpec[] = [];

  for (const ref of specs) {
    const read = catalog.get(specKey(ref));
    // A present-but-unparseable spec.yaml is reported, not routed: everything
    // read off it falls back to a default, so the det path would run it as a
    // spec that declares nothing and drop it with no report row.
    if (read?.error) {
      unresolved.push({ ...ref, title: null, reason: read.error, targetId: null });
      continue;
    }
    const spec = read?.spec ?? null;
    if (spec === null) {
      agentBrowser.push(ref);
      continue;
    }

    let plugin: TargetPlugin;
    try {
      plugin = resolve(spec, config);
    } catch (err) {
      unresolved.push({
        ...ref,
        title: spec.title ?? null,
        reason: err instanceof Error ? err.message : String(err),
        // Resolution failed, so report the *declared* id (spec.yaml `target:`
        // falling back to the config default) rather than a resolved one.
        targetId: spec.target ?? config.defaultTarget ?? null,
      });
      continue;
    }

    if (plugin.id === AGENT_BROWSER_TARGET) {
      agentBrowser.push(ref);
      continue;
    }

    const entry: DispatchedSpec = { ...ref, title: spec.title ?? null };
    const targetConfig = targetConfigFor(config, plugin.id);
    const routed = externalRunnability(plugin, plugin.id, targetConfig);
    if ("reason" in routed) {
      skipped.push({ ...entry, reason: routed.reason, targetId: plugin.id });
    } else {
      const group = externalById.get(plugin.id) ?? { ...externalGroupFor(routed.plugin, targetConfig), specs: [] };
      group.specs.push(entry);
      externalById.set(plugin.id, group);
    }
  }

  return { agentBrowser, external: [...externalById.values()], skipped, unresolved };
}

/**
 * Whether ccqa can execute this target's generated tests, and the group to put
 * them in when it can.
 *
 * Both routes ask it — a `spec.yaml` case reaching a target through its own
 * `target:`, and every case of a project that writes its own documents — and
 * the answer includes text that lands in a report row. Two copies would drift,
 * and a project's rows would read differently depending on which kind of
 * document states the case.
 */
export function externalRunnability(
  plugin: TargetPlugin | undefined,
  targetId: string,
  targetConfig: TargetConfig,
): { reason: string } | { plugin: TargetPlugin } {
  if (plugin === undefined) return { reason: `target "${targetId}" is not a target ccqa knows` };
  if (plugin.runner === undefined) {
    return { reason: `target "${targetId}" is generate-only (it has no runner)` };
  }
  if (targetConfig.runCommand === undefined) {
    return {
      reason:
        `target "${targetId}" has no \`runCommand\` in .ccqa/config.yaml, ` +
        `so its generated tests cannot be executed by ccqa run`,
    };
  }
  return { plugin };
}

/** The group a runnable target's specs go in. Callers add the specs. */
function externalGroupFor(
  plugin: TargetPlugin,
  targetConfig: TargetConfig,
): Omit<ExternalTargetGroup, "specs"> {
  return {
    targetId: plugin.id,
    runner: plugin.runner!,
    targetConfig,
    defaultTestPath: plugin.defaultTestPath,
    stepEvidence: plugin.stepEvidence ?? {
      supported: false,
      reason: `the "${plugin.id}" target does not capture step screenshots`,
    },
    browserCoverage: plugin.browserCoverage,
  };
}

/**
 * The external group for a project whose cases are its own documents.
 *
 * Such a case is not dispatched by reading a `spec.yaml` `target:` — the
 * target that declares the intent source already owns every case under it — so
 * the routing is one lookup rather than a walk. What it shares with
 * {@link groupSpecsByTarget} is the two conditions that decide whether ccqa
 * can execute a generated test at all: the plugin has a runner, and the
 * project configured the command to run it with.
 */
export function groupIntentCases(
  cases: readonly DispatchedSpec[],
  targetId: string,
  config: ProjectConfig,
): Pick<TargetDispatch, "external" | "skipped"> {
  // An empty group would still be logged as a target with a runner and run a
  // command with no files, so the boundary answers before it resolves anything.
  if (cases.length === 0) return { external: [], skipped: [] };
  const targetConfig = targetConfigFor(config, targetId);
  const routed = externalRunnability(registryFor(config).get(targetId), targetId, targetConfig);
  if ("reason" in routed) {
    return { external: [], skipped: cases.map((c) => ({ ...c, reason: routed.reason, targetId })) };
  }
  return {
    external: [{ ...externalGroupFor(routed.plugin, targetConfig), specs: [...cases] }],
    skipped: [],
  };
}

export interface ExternalRunContext {
  cwd: string;
  reportDir: string;
  concurrency: number;
  /** See `RunnerOptions.resources`. */
  resources: GroupLookup;
  model?: string;
  language?: string;
  /** Rows land here as they finish (report.json flush + hub sink under --report-to-hub). */
  report: IncrementalReport;
  /** Set by `ccqa run --coverage`; see `RunnerOptions.coverage`. */
  coverage?: CoverageCollector;
  /** The run's signal teardown; see `RunnerOptions.teardown`. */
  teardown?: RunTeardown;
}

/**
 * Execute the non-agent-browser share of a run: first the rows for specs that
 * can't run (unresolved target → failed, generate-only target → skipped),
 * then each external target group through its runner. Every row is upserted
 * into the incremental report the moment it exists — the runner reports each
 * spec through `onSpecComplete` as it finishes — so an interrupt keeps what
 * already ran and `--report-to-hub` streams spec by spec. Rows are also
 * returned for the tail phase (failure analysis) and the final batch write. A
 * crashing runner marks its own specs failed instead of aborting the run.
 */
export async function runExternalSpecs(
  dispatch: TargetDispatch,
  ctx: ExternalRunContext,
): Promise<ReportSpecResult[]> {
  const rows: ReportSpecResult[] = [];

  for (const u of dispatch.unresolved) {
    log.error(`${u.featureName}/${u.specName}: ${u.reason}`);
    rows.push({
      ...emptySpecRow({ feature: u.featureName, spec: u.specName, title: u.title, status: "failed" }),
      ...(u.targetId ? { target: u.targetId } : {}),
      analysisSkipped: "spec did not execute (target could not be resolved)",
      failureLogExcerpt: u.reason,
    });
  }
  for (const s of dispatch.skipped) {
    log.warn(`${s.featureName}/${s.specName}: skipped — ${s.reason}`);
    rows.push({
      ...emptySpecRow({ feature: s.featureName, spec: s.specName, title: s.title, status: "skipped" }),
      ...(s.targetId ? { target: s.targetId } : {}),
      skipReason: s.reason,
    });
  }
  // Row-level upsert (not upsertAll) so the hub sink fires per row under
  // --report-to-hub; upsertAll only flushes locally.
  for (const row of rows) await ctx.report.upsert(row);

  for (const group of dispatch.external) {
    log.blank();
    log.meta(
      "target",
      `${group.targetId} (${group.specs.length} spec${group.specs.length === 1 ? "" : "s"} via runCommand)`,
    );
    // Rows the runner already streamed (and upserted). The built-in
    // runCommandRunner never throws after streaming a row (its worker converts
    // any throw into that spec's failed row), so for it this catch only fires
    // on a throw *before* any spec ran and `streamed` is empty. Tracking it
    // still defends the generic TestRunner contract: if some other runner
    // streamed rows and then threw, the crash stubs below must not clobber the
    // rows it already upserted.
    const streamed: ReportSpecResult[] = [];
    let groupRows: ReportSpecResult[];
    try {
      groupRows = await group.runner.run(group.specs, {
        cwd: ctx.cwd,
        reportDir: ctx.reportDir,
        concurrency: ctx.concurrency,
        resources: ctx.resources,
        ...(ctx.model ? { model: ctx.model } : {}),
        ...(ctx.language ? { language: ctx.language } : {}),
        targetId: group.targetId,
        targetConfig: group.targetConfig,
        defaultTestPath: group.defaultTestPath,
        stepEvidence: group.stepEvidence,
        browserCoverage: group.browserCoverage,
        ...(ctx.coverage ? { coverage: ctx.coverage } : {}),
        ...(ctx.teardown ? { teardown: ctx.teardown } : {}),
        onSpecComplete: async (row) => {
          streamed.push(row);
          await ctx.report.upsert(row);
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`target ${group.targetId}: runner crashed: ${message}`);
      const done = new Set(streamed.map((r) => `${r.feature}/${r.spec}`));
      const crashRows = group.specs
        .filter((s) => !done.has(`${s.featureName}/${s.specName}`))
        .map((s) => ({
          ...emptySpecRow({ feature: s.featureName, spec: s.specName, title: s.title, status: "failed" }),
          target: group.targetId,
          analysisSkipped: "spec did not execute (runner crashed)",
          failureLogExcerpt: `runner for target "${group.targetId}" crashed: ${message}`,
        }));
      for (const row of crashRows) await ctx.report.upsert(row);
      groupRows = [...streamed, ...crashRows];
    }
    rows.push(...groupRows);
  }

  return rows;
}
