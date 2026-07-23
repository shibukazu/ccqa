import { stat } from "node:fs/promises";
import { join } from "node:path";
import { Command } from "commander";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { invokeClaudeStreaming } from "../claude/invoke.ts";
import { extractJsonBlock } from "../claude/extract-json.ts";
import {
  buildPerspectivesPrompt,
  buildPerspectivesSystemPrompt,
  type PerspectiveSpecForPrompt,
} from "../prompts/perspectives.ts";
import {
  getSpecDir,
  getTestScript,
  listFeatureTree,
  removeLegacyPerspectivesFiles,
  tryReadSpecFile,
  type FeatureTreeEntry,
} from "../store/index.ts";
import { tryParseTestSpec } from "../spec/parser.ts";
import { AGENT_BROWSER_TARGET } from "../spec/yaml-schema.ts";
import { loadProjectConfig, type ProjectConfig } from "../config/project-config.ts";
import { resolveTarget } from "../targets/registry.ts";
import { loadGeneratedManifest } from "../targets/llm-engine.ts";
import type { TargetPlugin } from "../targets/types.ts";
import {
  PerspectivesSchema,
  type PerspectiveFeature,
  type Perspectives,
  type PerspectiveSpec,
  type PerspectiveStatus,
} from "../types.ts";
import { DEFAULT_SPEC_MODE, SpecModeSchema, type SpecMode } from "../spec/yaml-schema.ts";
import type { HubClient } from "../hub-client/index.ts";
import { HubConnectionError, requireHubClient, withHubErrors, type HubConnOptions } from "./hub-conn.ts";
import { resolveProject } from "./resolve-project.ts";
import { formatToolSummary, printUnifiedDiff, prompt } from "./draft.ts";
import { addHubOptions, addLanguageOption, languageDirective, useJapanesePrompts } from "./options.ts";
import * as log from "./logger.ts";

interface PerspectivesOptions extends HubConnOptions {
  instruction?: string;
  apply?: boolean;
  check?: boolean;
  model?: string;
  language?: string;
  project?: string;
}

export const perspectivesCommand = addHubOptions(addLanguageOption(
  new Command("perspectives")
    .description(
      "Generate/update the project's perspectives document on the hub — a factual inventory of existing test coverage (no severity, no gap analysis)",
    )
    .option("--instruction <text>", "Hint to steer how summaries are written")
    .option("--apply", "Auto-apply without [y/N] confirmation", false)
    .option(
      "--check",
      "Verify the hub document still matches the local specs (mechanical fields only) and exit 1 when it is stale. No Claude calls — cheap enough for CI.",
      false,
    )
    .option("-m, --model <name>", "Claude model alias ('sonnet'|'opus'|'haiku') or full ID")
    .option("--project <name>", "Hub project to store the document under (default: cwd directory name)"),
)).action(withHubErrors(async (opts: PerspectivesOptions) => {
  if (opts.check) {
    await runPerspectivesCheck(opts);
  } else {
    await runPerspectives(opts);
  }
}));

/**
 * `--check`: compare the hub document against a freshly-built local skeleton
 * on the CLI-owned mechanical fields only (the spec set, titles,
 * relatedPaths, status). Claude-authored descriptive fields and the human
 * note are deliberately not compared — they are not deterministic, so they
 * can't signal staleness. Exit 1 on any mismatch; this is the CI gate for
 * "someone changed the specs without the inventory catching up".
 */
async function runPerspectivesCheck(opts: PerspectivesOptions): Promise<void> {
  const hub = requireHubOrExit(opts);
  const project = resolveProject(opts);
  log.header("perspectives", `check (project: ${project})`);

  const skeleton = await buildSkeleton(await listFeatureTree());
  const localCount = skeleton.reduce((n, f) => n + f.specs.length, 0);

  const existingDoc = await hub.getPerspectives(project);
  if (existingDoc === null) {
    if (localCount === 0) {
      log.info("no local test cases and no hub document — nothing to check.");
      return;
    }
    log.error(`no perspectives document on the hub for project "${project}" — run \`ccqa perspectives\` to create it`);
    process.exit(1);
  }
  const parsed = PerspectivesSchema.safeParse(existingDoc);
  if (!parsed.success) {
    log.error("the hub document does not match the perspectives schema — run `ccqa perspectives` to regenerate it");
    process.exit(1);
  }

  log.info(`checking ${localCount} local test case(s) against the hub document...`);
  const issues = comparePerspectivesSkeleton(skeleton, parsed.data);
  if (issues.length === 0) {
    log.blank();
    log.info(`perspectives are up to date (${localCount} case(s)).`);
    return;
  }
  log.blank();
  for (const issue of issues) {
    log.error(issue);
  }
  log.blank();
  log.error(`perspectives are stale (${issues.length} issue(s)) — run \`ccqa perspectives\` to regenerate`);
  process.exit(1);
}

/**
 * Mechanical-field comparison behind `--check`. Returns one human-readable
 * line per out-of-sync spec (empty when in sync). Exported for unit testing.
 */
export function comparePerspectivesSkeleton(
  local: PerspectiveFeature[],
  remote: Perspectives,
): string[] {
  const remoteMap = new Map<string, PerspectiveSpec>();
  for (const feature of remote.features) {
    for (const spec of feature.specs) {
      remoteMap.set(noteKey(feature.featureName, spec.specName), spec);
    }
  }

  const issues: string[] = [];
  const seen = new Set<string>();
  for (const feature of local) {
    for (const spec of feature.specs) {
      const key = noteKey(feature.featureName, spec.specName);
      seen.add(key);
      const remoteSpec = remoteMap.get(key);
      if (!remoteSpec) {
        issues.push(`${key}: not in the hub document`);
        continue;
      }
      const fields: string[] = [];
      if (remoteSpec.title !== spec.title) fields.push("title");
      if (!sameStringArray(remoteSpec.relatedPaths, spec.relatedPaths)) fields.push("relatedPaths");
      if (
        remoteSpec.status.mode !== spec.status.mode ||
        remoteSpec.status.traced !== spec.status.traced ||
        remoteSpec.status.generated !== spec.status.generated ||
        remoteSpec.status.target !== spec.status.target
      ) {
        fields.push(
          `status (local: ${formatStatus(spec.status)}, hub: ${formatStatus(remoteSpec.status)})`,
        );
      }
      if (fields.length > 0) {
        issues.push(`${key}: out of date — ${fields.join(", ")}`);
      }
    }
  }
  for (const key of remoteMap.keys()) {
    if (!seen.has(key)) {
      issues.push(`${key}: no longer exists locally (stale hub entry)`);
    }
  }
  return issues;
}

function formatStatus(status: PerspectiveStatus): string {
  const target = status.target ? `/target=${status.target}` : "";
  return `${status.mode}/traced=${status.traced}/generated=${status.generated}${target}`;
}

/** Order-sensitive equality; an absent list and an empty list are the same thing. */
function sameStringArray(a: string[] | undefined, b: string[] | undefined): boolean {
  const left = a ?? [];
  const right = b ?? [];
  return left.length === right.length && left.every((v, i) => v === right[i]);
}

/** Perspectives live on the hub only — no hub, no place to store (or check) them. */
function requireHubOrExit(opts: PerspectivesOptions): HubClient {
  try {
    return requireHubClient(opts);
  } catch (err) {
    if (err instanceof HubConnectionError) {
      log.error(err.message);
      log.hint("perspectives are stored on the hub — start one with `ccqa serve`");
      process.exit(2);
    }
    throw err;
  }
}

async function runPerspectives(opts: PerspectivesOptions): Promise<void> {
  const hub = requireHubOrExit(opts);
  const project = resolveProject(opts);
  log.header("perspectives", `project: ${project}`);

  // 1. Mechanical skeleton: every feature/spec with title + relatedPaths + status.
  const tree = await listFeatureTree();
  const skeleton = await buildSkeleton(tree);
  const allSpecs = skeleton.flatMap((f) => f.specs);

  if (allSpecs.length === 0) {
    log.info("no test cases found under .ccqa/features — nothing to inventory.");
    return;
  }

  // 2. Carry over human-authored notes from the hub's current document (if any).
  const existingDoc = await hub.getPerspectives(project);
  const noteMap = extractNotes(existingDoc);

  // 3. Ask Claude for summaries only. The structure is already fixed above.
  const specBodies = await loadSpecBodies(skeleton);
  log.meta("language", opts.language ?? "auto");
  log.info(`Summarising ${allSpecs.length} test case(s) across ${skeleton.length} feature(s)...`);
  const summaries = await requestSummaries(specBodies, opts);
  if (summaries === null) {
    process.exit(1);
  }

  // 4. Merge skeleton + summaries + preserved notes; validate.
  const merged = mergePerspectives(skeleton, summaries, noteMap);
  let validated: Perspectives;
  try {
    validated = PerspectivesSchema.parse(merged);
  } catch (e) {
    log.error(`refused to push: assembled perspectives failed validation (${(e as Error).message})`);
    process.exit(1);
  }

  // The diff is shown as YAML (readable); the transport/storage format is
  // JSON. Compare ignoring the always-fresh `generatedAt` stamp so a truly
  // no-op regeneration short-circuits instead of differing on the timestamp
  // line alone.
  const existingYaml = existingDoc === null ? "" : stringifyYaml(existingDoc, { lineWidth: 0 });
  const next = stringifyYaml(validated, { lineWidth: 0 });
  if (withoutGeneratedAt(existingYaml) === withoutGeneratedAt(next)) {
    log.blank();
    log.info("perspectives already up to date — no changes.");
    await cleanupLegacyLocalFiles();
    return;
  }

  log.blank();
  log.info("--- proposed changes (YAML view of the hub document) ---");
  printUnifiedDiff(existingYaml, next);
  log.blank();

  const apply =
    opts.apply === true ||
    /^y/i.test(
      await prompt(
        useJapanesePrompts(opts.language)
          ? "hub に perspectives を保存しますか? [y/N] "
          : "Push perspectives to the hub? [y/N] ",
      ),
    );
  if (!apply) {
    log.info("aborted — no changes written.");
    return;
  }

  await hub.putPerspectives(project, validated);
  log.meta("pushed", `perspectives (project: ${project})`);
  await cleanupLegacyLocalFiles();
}

/**
 * Perspectives used to be written into the repo (`.ccqa/perspectives.yaml`,
 * `.ccqa/perspectives.md`, `.ccqa/features/<f>/perspectives.md`). Now that
 * the document is hub-only, sweep those leftovers whenever the command runs
 * so consuming repos converge without a manual cleanup.
 */
async function cleanupLegacyLocalFiles(): Promise<void> {
  const removed = await removeLegacyPerspectivesFiles();
  for (const path of removed) log.meta("removed legacy file", path);
}

// --- Pure, testable building blocks ---

/**
 * Turn the feature tree into the skeleton perspectives features: title +
 * relatedPaths transcribed from each spec, status derived mechanically from
 * on-disk artifacts. `summary` is left empty here; Claude fills it later.
 * Specs whose spec.yaml is missing or unparsable are skipped.
 */
export async function buildSkeleton(tree: FeatureTreeEntry[]): Promise<PerspectiveFeature[]> {
  // Config resolves each spec's target once for the whole sweep; a broken
  // config is not a reason to fail the inventory, so fall back to the schema
  // default (agent-browser) if it can't be loaded.
  const config = await loadProjectConfig(process.cwd()).catch(() => null);
  const features = await Promise.all(
    tree.map(async (feature): Promise<PerspectiveFeature> => {
      const specs = await Promise.all(
        feature.specs
          .filter((s) => s.hasSpecFile)
          .map(async (s): Promise<PerspectiveSpec> => {
            // One read of spec.yaml feeds both the title/mode and the target.
            const specYaml = await tryReadSpecFile(feature.featureName, s.specName);
            const meta = readSpecMeta(s.specName, specYaml);
            const plugin = resolveSpecTarget(specYaml, config);
            const status = await deriveStatus(feature.featureName, s.specName, meta.mode, plugin);
            const entry: PerspectiveSpec = {
              specName: s.specName,
              title: meta.title,
              summary: "",
              status,
            };
            if (s.relatedPaths) entry.relatedPaths = s.relatedPaths;
            return entry;
          }),
      );
      return { featureName: feature.featureName, specs };
    }),
  );
  // Drop features that ended up with no usable specs; sort for stable output.
  return features
    .filter((f) => f.specs.length > 0)
    .map((f) => ({
      featureName: f.featureName,
      specs: [...f.specs].sort((a, b) => a.specName.localeCompare(b.specName)),
    }))
    .sort((a, b) => a.featureName.localeCompare(b.featureName));
}

/**
 * `(featureName, specName)` → human note, extracted from the hub's current
 * perspectives document. Notes are preserved across regeneration; everything
 * else (title, status, summary) is recomputed. Returns an empty map when the
 * document is absent or doesn't match the schema — note preservation is
 * best-effort and never blocks regeneration.
 */
export function extractNotes(existing: unknown): Map<string, string> {
  const map = new Map<string, string>();
  if (existing === null || existing === undefined) return map;
  const result = PerspectivesSchema.safeParse(existing);
  if (!result.success) return map;
  for (const feature of result.data.features) {
    for (const spec of feature.specs) {
      if (spec.note !== undefined && spec.note !== "") {
        map.set(noteKey(feature.featureName, spec.specName), spec.note);
      }
    }
  }
  return map;
}

/**
 * Merge the mechanical skeleton with Claude's summaries and the preserved
 * notes into the final perspectives object. Summaries are matched by
 * (featureName, specName); an unmatched spec keeps its empty summary.
 */
export function mergePerspectives(
  skeleton: PerspectiveFeature[],
  summaries: SummaryEntry[],
  noteMap: Map<string, string>,
): Perspectives {
  const summaryMap = new Map<string, SummaryEntry>();
  for (const s of summaries) {
    summaryMap.set(noteKey(s.featureName, s.specName), s);
  }

  const features = skeleton.map((feature) => ({
    featureName: feature.featureName,
    specs: feature.specs.map((spec) => {
      const key = noteKey(feature.featureName, spec.specName);
      const entry = summaryMap.get(key);
      const merged: PerspectiveSpec = {
        ...spec,
        summary: entry?.summary ?? spec.summary,
      };
      if (entry?.startScreen) merged.startScreen = entry.startScreen;
      if (entry?.testCondition) merged.testCondition = entry.testCondition;
      if (entry?.preconditions && entry.preconditions.length > 0) {
        merged.preconditions = entry.preconditions;
      }
      const note = noteMap.get(key);
      if (note !== undefined) merged.note = note;
      return merged;
    }),
  }));

  return { generatedAt: new Date().toISOString(), features };
}

/**
 * Strip the top-level `generatedAt:` line so two serialised perspectives can
 * be compared for substantive equality without the always-fresh timestamp
 * defeating the "already up to date" check. Exported for unit testing.
 */
export function withoutGeneratedAt(yamlText: string): string {
  return yamlText
    .split("\n")
    .filter((line) => !/^generatedAt:/.test(line))
    .join("\n")
    .trim();
}

export interface SummaryEntry {
  featureName: string;
  specName: string;
  summary: string;
  startScreen?: string;
  testCondition?: string;
  preconditions?: string[];
}

export function noteKey(featureName: string, specName: string): string {
  return `${featureName}/${specName}`;
}

// --- I/O helpers (kept thin so the pure functions above stay testable) ---

/** Lenient title/mode read from an already-loaded spec.yaml (null → defaults). */
export function readSpecMeta(specName: string, specYaml: string | null): { title: string; mode: SpecMode } {
  if (specYaml === null) return { title: specName, mode: DEFAULT_SPEC_MODE };
  try {
    const parsed = parseYaml(specYaml) as { title?: unknown; mode?: unknown };
    const title = typeof parsed.title === "string" && parsed.title.length > 0
      ? parsed.title
      : specName;
    const modeResult = SpecModeSchema.safeParse(parsed.mode);
    const mode = modeResult.success ? modeResult.data : DEFAULT_SPEC_MODE;
    return { title, mode };
  } catch {
    return { title: specName, mode: DEFAULT_SPEC_MODE };
  }
}

/**
 * Resolve a spec's generation target for coverage derivation, from its
 * already-read spec.yaml. Best-effort: an unparseable spec or a target that
 * can't be resolved (unknown id, agent-browser-only field misuse) falls back
 * to agent-browser (null), so the inventory never fails over one bad spec.
 */
export function resolveSpecTarget(
  specYaml: string | null,
  config: ProjectConfig | null,
): TargetPlugin | null {
  if (config === null || specYaml === null) return null;
  const spec = tryParseTestSpec(specYaml);
  if (!spec) return null;
  try {
    return resolveTarget(spec, config);
  } catch {
    return null;
  }
}

/**
 * Coverage facts for one spec, interpreted through its target (see
 * `PerspectiveStatusSchema`). `plugin` null means the default agent-browser
 * target (also the fallback for a spec whose target couldn't be resolved) —
 * every caller must resolve it (via `resolveSpecTarget`) and pass it, so the
 * write path and the `--check` comparison agree on the target dimension.
 */
export async function deriveStatus(
  featureName: string,
  specName: string,
  mode: SpecMode,
  plugin: TargetPlugin | null,
): Promise<PerspectiveStatus> {
  const isAgentBrowser = plugin === null || plugin.id === AGENT_BROWSER_TARGET;
  const recordingPath = join(getSpecDir(featureName, specName), "ir.json");
  const hasRecording = await stat(recordingPath).then(() => true).catch(() => false);

  if (isAgentBrowser) {
    const generated = (await getTestScript(featureName, specName)) !== null;
    return { mode, traced: hasRecording, generated };
  }

  // External target: "generated" is its own manifest, not test.spec.ts.
  // A spec-input target (runn) has no record phase, so tracing is not a gap.
  const generated =
    (await loadGeneratedManifest({ featureName, specName }, process.cwd())) !== null;
  const traced = plugin.input === "recording" ? hasRecording : true;
  return { mode, traced, generated, target: plugin.id };
}

async function loadSpecBodies(skeleton: PerspectiveFeature[]): Promise<PerspectiveSpecForPrompt[]> {
  const entries = await Promise.all(
    skeleton.flatMap((feature) =>
      feature.specs.map(async (spec): Promise<PerspectiveSpecForPrompt> => {
        const specYaml = (await tryReadSpecFile(feature.featureName, spec.specName)) ?? "";
        return {
          featureName: feature.featureName,
          specName: spec.specName,
          title: spec.title,
          specYaml,
        };
      }),
    ),
  );
  return entries;
}

export interface SummaryRequestOptions {
  instruction?: string;
  model?: string;
  language?: string;
}

export async function requestSummaries(
  specs: PerspectiveSpecForPrompt[],
  opts: SummaryRequestOptions,
): Promise<SummaryEntry[] | null> {
  const toolCounts: Record<string, number> = {};
  const startedAt = Date.now();
  const { result, isError } = await invokeClaudeStreaming(
    {
      prompt: buildPerspectivesPrompt(specs, opts.instruction),
      systemPrompt: buildPerspectivesSystemPrompt() + languageDirective(opts.language),
      allowedTools: ["Read", "Grep", "Glob"],
      silenceBashLog: true,
      ...(opts.model ? { model: opts.model } : {}),
    },
    (msg: SDKMessage) => {
      if (msg.type !== "assistant") return;
      for (const block of msg.message.content ?? []) {
        if (block.type === "tool_use") {
          toolCounts[block.name] = (toolCounts[block.name] ?? 0) + 1;
        }
      }
    },
  );
  process.stdout.write(`${formatToolSummary(toolCounts, Date.now() - startedAt)}\n`);

  if (isError) {
    log.error("Claude returned an error result");
    return null;
  }

  const json = extractJsonBlock(result);
  if (!json) {
    log.error("Claude did not return a json block");
    return null;
  }

  return parseSummaries(json);
}

/**
 * Parse the `{ summaries: [...] }` JSON contract into typed entries. Returns
 * null and logs when the payload is malformed. Exported for unit testing.
 */
export function parseSummaries(json: string): SummaryEntry[] | null {
  let payload: unknown;
  try {
    payload = JSON.parse(json);
  } catch (e) {
    log.error(`failed to parse summaries JSON: ${(e as Error).message}`);
    return null;
  }
  // `JSON.parse("null")` / `"123"` etc. yield non-objects; guard before the
  // property access so a malformed payload logs-and-returns instead of
  // throwing an uncaught TypeError outside the try.
  if (typeof payload !== "object" || payload === null) {
    log.error("summaries payload is not an object");
    return null;
  }
  const summaries = (payload as { summaries?: unknown }).summaries;
  if (!Array.isArray(summaries)) {
    log.error("summaries payload missing a `summaries` array");
    return null;
  }
  const out: SummaryEntry[] = [];
  for (const item of summaries) {
    const rec = (item ?? {}) as Record<string, unknown>;
    const { featureName, specName, summary } = rec;
    if (typeof featureName === "string" && typeof specName === "string" && typeof summary === "string") {
      const entry: SummaryEntry = { featureName, specName, summary };
      if (typeof rec.startScreen === "string" && rec.startScreen.length > 0) {
        entry.startScreen = rec.startScreen;
      }
      if (typeof rec.testCondition === "string" && rec.testCondition.length > 0) {
        entry.testCondition = rec.testCondition;
      }
      if (Array.isArray(rec.preconditions)) {
        const pre = rec.preconditions.filter((p): p is string => typeof p === "string" && p.length > 0);
        if (pre.length > 0) entry.preconditions = pre;
      }
      out.push(entry);
    }
  }
  return out;
}
