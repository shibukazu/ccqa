import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { Command } from "commander";
import { stringify as stringifyYaml } from "yaml";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { invokeClaudeStreaming } from "../claude/invoke.ts";
import { extractJsonBlock } from "../claude/extract-json.ts";
import {
  buildPerspectivesPrompt,
  buildPerspectivesSystemPrompt,
  type PerspectiveSpecForPrompt,
} from "../prompts/perspectives.ts";
import {
  caseRefFor,
  findRecordingPath,
  removeLegacyPerspectivesFiles,
  splitCaseId,
} from "../store/index.ts";
import type { TestCase } from "../cases/case.ts";
import { openCaseReader, type CaseReader } from "../cases/reader.ts";
import type { CaseRead } from "../cases/source.ts";
import { readCaseChangedAt } from "../spec/spec-changed-at.ts";
import { AGENT_BROWSER_TARGET, DEFAULT_SPEC_MODE } from "../spec/yaml-schema.ts";
import {
  loadProjectConfig,
  ProjectConfigSchema,
  targetConfigFor,
  type ProjectConfig,
} from "../config/project-config.ts";
import { registryFor, resolveTarget } from "../targets/registry.ts";
import { agentBrowserTarget } from "../targets/agent-browser/index.ts";
import { resolveCaseRecordingPath, resolveCaseTestPath } from "../targets/test-path.ts";
import type { TargetPlugin } from "../targets/types.ts";
import {
  PerspectivesSchema,
  type PerspectiveFeature,
  type Perspectives,
  type PerspectiveSpec,
  type PerspectiveStatus,
  type PerspectiveStep,
} from "../types.ts";
import type { HubClient } from "../hub-client/index.ts";
import { HubConnectionError, requireHubClient, withHubErrors, type HubConnOptions } from "./hub-conn.ts";
import { resolveProject } from "./resolve-project.ts";
import { formatToolSummary, printUnifiedDiff, prompt } from "./draft.ts";
import { addHubOptions, addLanguageOption, languageDirective, useJapanesePrompts } from "./options.ts";
import * as log from "./logger.ts";
import { withCostReporting } from "./cost-line.ts";

interface PerspectivesOptions extends HubConnOptions {
  instruction?: string;
  yes?: boolean;
  verify?: boolean;
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
    .option("-y, --yes", "Apply without asking [y/N]", false)
    .option(
      "--verify",
      "Check the hub document against the local specs (mechanical fields only) and exit 1 when it is stale. No Claude calls — cheap enough for CI.",
      false,
    )
    .option("-m, --model <name>", "Claude model alias ('sonnet'|'opus'|'haiku') or full ID")
    .option("--project <name>", "Hub project to store the document under (default: cwd directory name)"),
)).action(withHubErrors(async (opts: PerspectivesOptions) => {
  await withCostReporting("perspectives", () => (opts.verify ? runPerspectivesCheck(opts) : runPerspectives(opts)));
}));

/**
 * `--check`: compare the hub document against a freshly-built local skeleton
 * on the CLI-owned mechanical fields only (the spec set, titles, status).
 * Claude-authored descriptive fields and the human note are deliberately not
 * compared — they are not deterministic, so they can't signal staleness.
 * Exit 1 on any mismatch; this is the CI gate for "someone changed the specs
 * without the inventory catching up".
 */
async function runPerspectivesCheck(opts: PerspectivesOptions): Promise<void> {
  const hub = requireHubOrExit(opts);
  const project = resolveProject(opts);
  log.header("perspectives", `check (project: ${project})`);

  const skeleton = await buildSkeleton(await openLocalCases());
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
      // The hub decides which specs an audit owes an answer for by reading
      // this field here, so a document that disagrees keeps asking about a
      // spec that was turned off — the one staleness nothing else surfaces.
      if ((remoteSpec.disabled ?? false) !== (spec.disabled ?? false)) fields.push("disabled");
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

  // 1. Mechanical skeleton: every case with title + status.
  const local = await openLocalCases();
  const skeleton = await buildSkeleton(local);
  const allSpecs = skeleton.flatMap((f) => f.specs);

  if (allSpecs.length === 0) {
    log.info(`no test cases found under ${local.where} — nothing to inventory.`);
    return;
  }

  // 2. Carry over human-authored notes from the hub's current document (if any).
  const existingDoc = await hub.getPerspectives(project);
  const noteMap = extractNotes(existingDoc);

  // 3. Ask Claude for summaries only. The structure is already fixed above.
  const specBodies = loadSpecBodies(skeleton, local);
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
    opts.yes === true ||
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
 * Turn the project's cases into the skeleton perspectives features: title
 * transcribed from each case, status derived mechanically from on-disk
 * artifacts, grouped by the feature half of the case's id. `summary` is left
 * empty here; Claude fills it later.
 */
export async function buildSkeleton(local: LocalCases): Promise<PerspectiveFeature[]> {
  // One git walk for the whole tree; each case picks its own entry out of it.
  const changedAt = await readCaseChangedAt(
    process.cwd(),
    local.cases.map((c) => c.document!.path),
  );
  const byFeature = new Map<string, PerspectiveSpec[]>();
  for (const read of local.cases) {
    const { featureName, specName } = splitCaseId(read.id);
    const testCase = read.case;
    // A case that will not read is still listed, with what its id says and
    // nothing invented. Dropping it would take it out of every answer the hub
    // gives — attestation, re-run, audit-need — on no evidence at all, and the
    // document it could not read is exactly what a person has to go look at.
    if (testCase === null) log.warn(`${read.id}: ${read.error ?? "could not be read"}`);
    const steps = testCase ? transcribeSteps(testCase.spec?.steps ?? testCase.steps) : [];
    const lastEdit = changedAt.get(read.document!.path);
    const built: PerspectiveSpec = {
      specName,
      title: testCase?.title ?? specName,
      summary: "",
      ...(steps.length > 0 ? { steps } : {}),
      status: await deriveStatus(read.id, testCase, local),
      ...(lastEdit ? { changedAt: lastEdit } : {}),
      // Listed but flagged: the hub skips it when deciding what an audit owes
      // an answer for, and the `note` a person wrote on it survives being
      // turned off.
      ...(testCase?.disabled ? { disabled: true } : {}),
    };
    const specs = byFeature.get(featureName);
    if (specs) specs.push(built);
    else byFeature.set(featureName, [built]);
  }
  // Sort for stable output.
  return [...byFeature.entries()]
    .map(([featureName, specs]) => ({
      featureName,
      specs: [...specs].sort((a, b) => a.specName.localeCompare(b.specName)),
    }))
    .sort((a, b) => a.featureName.localeCompare(b.featureName));
}

/**
 * Every case this checkout states, read once, plus what the whole sweep needs
 * to say where each case's files live.
 *
 * Read through the one reader, so the inventory covers a project whose cases
 * are its own documents exactly as it covers ccqa's own specs — the hub's
 * attestation, re-run and audit-need answers all start from this document, and
 * a project with no document at all is a project the hub cannot answer for.
 */
export interface LocalCases {
  /** Every case the source holds, read. A case that would not read is kept. */
  cases: CaseRead[];
  config: ProjectConfig;
  reader: CaseReader;
  /** Where the cases were looked for, for the "nothing to inventory" line. */
  where: string;
}

async function openLocalCases(): Promise<LocalCases> {
  const cwd = process.cwd();
  // A broken config is not a reason to fail the inventory, so fall back to the
  // schema default (agent-browser) if it cannot be loaded.
  const config = await loadProjectConfig(cwd).catch(() => ProjectConfigSchema.parse({}));
  const reader = openCaseReader(config, cwd);
  const ids = await reader.list();
  const read = await Promise.all(ids.map((id) => reader.read(id)));
  return {
    // A case with no document at all is not in the inventory; one whose
    // document will not read is (see `buildSkeleton`).
    cases: read.filter((r) => r.document !== null),
    config,
    reader,
    where: reader.target ? reader.target.module : ".ccqa/features",
  };
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

/**
 * The case's procedure, copied verbatim for the inventory: an include step
 * keeps only the block name (its params are wiring, not procedure), an action
 * step keeps its instruction/expected text, a judge step its claim.
 *
 * Read off the document rather than off the expanded steps, so a `spec.yaml`
 * case still shows the block it includes rather than that block's contents —
 * the inventory is a stock-take of what each case says, and inlining a shared
 * login into forty cases says the same thing forty times.
 *
 * Anything malformed is skipped: the inventory never fails over one bad step.
 */
export function transcribeSteps(raw: unknown): PerspectiveStep[] {
  if (!Array.isArray(raw)) return [];
  const steps: PerspectiveStep[] = [];
  for (const step of raw) {
    if (typeof step !== "object" || step === null) continue;
    const s = step as {
      include?: unknown;
      instruction?: unknown;
      expected?: unknown;
      judgeByLlm?: unknown;
    };
    if (typeof s.include === "string" && s.include.length > 0) {
      steps.push({ include: s.include });
    } else if (typeof s.judgeByLlm === "string" && s.judgeByLlm.length > 0) {
      steps.push({ judgeByLlm: s.judgeByLlm });
    } else if (typeof s.instruction === "string" && s.instruction.length > 0) {
      steps.push({
        instruction: s.instruction,
        ...(typeof s.expected === "string" && s.expected.length > 0 ? { expected: s.expected } : {}),
      });
    }
  }
  return steps;
}

/**
 * The target that owns this case's generated files.
 *
 * A case the project states itself belongs to the target that declared the
 * source; a `spec.yaml` case names its own. Best-effort: an unresolvable
 * target falls back to agent-browser, so the inventory never fails over one
 * bad case.
 */
function targetOf(testCase: TestCase | null, local: LocalCases): TargetPlugin | null {
  if (local.reader.target) return registryFor(local.config).get(local.reader.target.id) ?? null;
  if (testCase?.spec == null) return null;
  try {
    return resolveTarget(testCase.spec, local.config);
  } catch {
    return null;
  }
}

/**
 * Coverage facts for one case, interpreted through its target (see
 * `PerspectiveStatusSchema`).
 */
export async function deriveStatus(
  id: string,
  testCase: TestCase | null,
  local: LocalCases,
): Promise<PerspectiveStatus> {
  const cwd = process.cwd();
  const plugin = targetOf(testCase, local);
  // Both halves of "generated" are the same question — is there a test file at
  // the path this case's target puts it? — so agent-browser and the external
  // targets differ only in which target answers it.
  const target = plugin ?? agentBrowserTarget;
  const targetConfig = local.reader.target?.targetConfig ?? targetConfigFor(local.config, target.id);
  const generated = await exists(resolve(cwd, resolveCaseTestPath(target, targetConfig, id)));
  const recordingPath = resolveCaseRecordingPath(target, targetConfig, id);
  const hasRecording = (await findRecordingPath(caseRefFor(id, cwd, recordingPath))) !== null;
  // A spec-input target (runn) has no record phase, so tracing is not a gap.
  const traced = target.input === "recording" ? hasRecording : true;
  return {
    mode: testCase?.mode ?? DEFAULT_SPEC_MODE,
    traced,
    generated,
    ...(plugin && plugin.id !== AGENT_BROWSER_TARGET ? { target: plugin.id } : {}),
  };
}

function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/** `splitCaseId` as the two positional arguments `noteKey` takes. */
function splitPair(id: string): [string, string] {
  const { featureName, specName } = splitCaseId(id);
  return [featureName, specName];
}

function loadSpecBodies(
  skeleton: PerspectiveFeature[],
  local: LocalCases,
): PerspectiveSpecForPrompt[] {
  // Keyed the way the skeleton spells a case — the feature/spec pair — because
  // that is what the lookup below has. A single-segment id does not survive
  // the split-and-rejoin, and keying by the raw id silently fed the summariser
  // an empty document.
  const byKey = new Map(
    local.cases.map((c) => [noteKey(...splitPair(c.id)), c.document?.text ?? ""]),
  );
  return skeleton.flatMap((feature) =>
    feature.specs.map((spec) => ({
      featureName: feature.featureName,
      specName: spec.specName,
      title: spec.title,
      specYaml: byKey.get(noteKey(feature.featureName, spec.specName)) ?? "",
    })),
  );
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
