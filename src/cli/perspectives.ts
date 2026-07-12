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
  ensureCcqaDir,
  getSpecDir,
  getTestScript,
  listFeatureTree,
  saveFeaturePerspectivesMarkdown,
  savePerspectives,
  savePerspectivesMarkdown,
  tryReadPerspectives,
  tryReadSpecFile,
  type FeatureTreeEntry,
} from "../store/index.ts";
import {
  PerspectivesSchema,
  type PerspectiveFeature,
  type Perspectives,
  type PerspectiveSpec,
  type PerspectiveStatus,
} from "../types.ts";
import { DEFAULT_SPEC_MODE, SpecModeSchema, type SpecMode } from "../spec/yaml-schema.ts";
import { formatToolSummary, printUnifiedDiff, prompt } from "./draft.ts";
import { addLanguageOption, languageDirective, useJapanesePrompts } from "./options.ts";
import * as log from "./logger.ts";

interface PerspectivesOptions {
  instruction?: string;
  apply?: boolean;
  model?: string;
  language?: string;
}

export const perspectivesCommand = addLanguageOption(
  new Command("perspectives")
    .description(
      "Generate/update .ccqa/perspectives.yaml — a factual inventory of existing test coverage (no severity, no gap analysis)",
    )
    .option("--instruction <text>", "Hint to steer how summaries are written")
    .option("--apply", "Auto-apply without [y/N] confirmation", false)
    .option("-m, --model <name>", "Claude model alias ('sonnet'|'opus'|'haiku') or full ID"),
).action(async (opts: PerspectivesOptions) => {
  await runPerspectives(opts);
});

async function runPerspectives(opts: PerspectivesOptions): Promise<void> {
  log.header("perspectives", ".ccqa/perspectives.yaml");

  await ensureCcqaDir();

  // 1. Mechanical skeleton: every feature/spec with title + relatedPaths + status.
  const tree = await listFeatureTree();
  const skeleton = await buildSkeleton(tree);
  const allSpecs = skeleton.flatMap((f) => f.specs);

  if (allSpecs.length === 0) {
    log.info("no test cases found under .ccqa/features — nothing to inventory.");
    return;
  }

  // 2. Carry over human-authored notes from the existing file (if any).
  const existingRaw = (await tryReadPerspectives()) ?? "";
  const noteMap = extractNotes(existingRaw);

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
    log.error(`refused to write: assembled perspectives failed validation (${(e as Error).message})`);
    process.exit(1);
  }

  const next = stringifyYaml(validated, { lineWidth: 0 });
  // Compare ignoring the always-fresh `generatedAt` stamp; otherwise a truly
  // no-op regeneration would still differ on the timestamp line alone and the
  // "already up to date" fast path (and the .md no-rewrite it implies) would
  // never fire.
  if (withoutGeneratedAt(existingRaw) === withoutGeneratedAt(next)) {
    log.blank();
    log.info("perspectives already up to date — no changes.");
    return;
  }

  // The diff is shown on the YAML, which is the machine-readable source of
  // truth; the Markdown view is regenerated from it on apply.
  log.blank();
  log.info("--- proposed changes (perspectives.yaml) ---");
  printUnifiedDiff(existingRaw, next);
  log.blank();

  const apply =
    opts.apply === true ||
    /^y/i.test(
      await prompt(
        useJapanesePrompts(opts.language)
          ? "perspectives.yaml + .md を書き込みますか? [y/N] "
          : "Write perspectives.yaml + .md? [y/N] ",
      ),
    );
  if (!apply) {
    log.info("aborted — no changes written.");
    return;
  }

  const savedYaml = await savePerspectives(next);
  log.meta("saved", savedYaml);

  // Root .md is a thin category index; the detailed per-case tables live in
  // .ccqa/features/<feature>/perspectives.md, one file per category. Labels
  // follow --language so the chrome matches the AI-written field values.
  const labels = labelsFor(opts.language);
  const savedIndexMd = await savePerspectivesMarkdown(renderIndexMarkdown(validated, labels));
  log.meta("saved", savedIndexMd);
  for (const feature of validated.features) {
    const savedFeatureMd = await saveFeaturePerspectivesMarkdown(
      feature.featureName,
      renderFeatureMarkdown(feature, labels),
    );
    log.meta("saved", savedFeatureMd);
  }
}

// --- Pure, testable building blocks ---

/**
 * Turn the feature tree into the skeleton perspectives features: title +
 * relatedPaths transcribed from each spec, status derived mechanically from
 * on-disk artifacts. `summary` is left empty here; Claude fills it later.
 * Specs whose spec.yaml is missing or unparsable are skipped.
 */
export async function buildSkeleton(tree: FeatureTreeEntry[]): Promise<PerspectiveFeature[]> {
  const features = await Promise.all(
    tree.map(async (feature): Promise<PerspectiveFeature> => {
      const specs = await Promise.all(
        feature.specs
          .filter((s) => s.hasSpecFile)
          .map(async (s): Promise<PerspectiveSpec> => {
            const spec = await readSpecMeta(feature.featureName, s.specName);
            const status = await deriveStatus(feature.featureName, s.specName, spec.mode);
            const entry: PerspectiveSpec = {
              specName: s.specName,
              title: spec.title,
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
 * `(featureName, specName)` → human note, parsed from an existing
 * perspectives.yaml. Notes are preserved across regeneration; everything
 * else (title, status, summary) is recomputed. Returns an empty map when the
 * input is empty or unparsable — note preservation is best-effort and never
 * blocks regeneration.
 */
export function extractNotes(existingRaw: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!existingRaw.trim()) return map;
  let parsed: unknown;
  try {
    parsed = parseYaml(existingRaw);
  } catch {
    return map;
  }
  const result = PerspectivesSchema.safeParse(parsed);
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

function noteKey(featureName: string, specName: string): string {
  return `${featureName}/${specName}`;
}

// --- I/O helpers (kept thin so the pure functions above stay testable) ---

async function readSpecMeta(
  featureName: string,
  specName: string,
): Promise<{ title: string; mode: SpecMode }> {
  const raw = await tryReadSpecFile(featureName, specName);
  if (raw === null) return { title: specName, mode: DEFAULT_SPEC_MODE };
  try {
    const parsed = parseYaml(raw) as { title?: unknown; mode?: unknown };
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

async function deriveStatus(
  featureName: string,
  specName: string,
  mode: SpecMode,
): Promise<PerspectiveStatus> {
  const recordingPath = join(getSpecDir(featureName, specName), "ir.json");
  const traced = await stat(recordingPath).then(() => true).catch(() => false);
  const generated = (await getTestScript(featureName, specName)) !== null;
  return { mode, traced, generated };
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

async function requestSummaries(
  specs: PerspectiveSpecForPrompt[],
  opts: PerspectivesOptions,
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

// --- Markdown view ---

/**
 * Labels for the rendered Markdown — headings, table headers, row names.
 * These follow the `--language` flag so the view's chrome matches the
 * AI-written field values (which are themselves language-directed). The case
 * titles stay verbatim from spec.yaml regardless, so a Japanese-titled spec
 * keeps its title even under `en`.
 */
interface MarkdownLabels {
  indexTitle: string;
  caseCol: string;
  itemCol: string;
  valueCol: string;
  modeCol: string;
  statusCol: string;
  modeLabel: string;
  summary: string;
  preconditions: string;
  startScreen: string;
  relatedCode: string;
  modeDeterministic: string;
  modeLive: string;
  /**
   * Shown for any deterministic spec without a `test.spec.ts`, whether or
   * not it was traced. The trace/codegen split is an internal step of
   * `ccqa record`; from the reviewer's perspective the spec is simply
   * "not recorded yet" until `test.spec.ts` exists. Live specs are always
   * runnable, so this label only applies to deterministic specs.
   */
  notRunnable: string;
  runnable: string;
}

const LABELS_JA: MarkdownLabels = {
  indexTitle: "テスト観点インデックス (perspectives)",
  caseCol: "ケース",
  itemCol: "項目",
  valueCol: "内容",
  modeCol: "モード",
  statusCol: "状態",
  modeLabel: "モード",
  summary: "検証内容",
  preconditions: "前提条件",
  startScreen: "開始画面",
  relatedCode: "関連コード",
  modeDeterministic: "deterministic",
  modeLive: "live",
  notRunnable: "⚠️ 未record",
  runnable: "✅ 実行可能",
};

const LABELS_EN: MarkdownLabels = {
  indexTitle: "Test Perspectives (perspectives)",
  caseCol: "Case",
  itemCol: "Item",
  valueCol: "Value",
  modeCol: "Mode",
  statusCol: "Status",
  modeLabel: "Mode",
  summary: "Verifies",
  preconditions: "Preconditions",
  startScreen: "Start screen",
  relatedCode: "Related code",
  modeDeterministic: "deterministic",
  modeLive: "live",
  notRunnable: "⚠️ not recorded",
  runnable: "✅ runnable",
};

/**
 * Pick the label set for a `--language` value. Only an explicit English tag
 * (`en`, `en-US`, …) switches to English labels; `auto`, `ja`, and anything
 * else keep Japanese, matching the source-following default the rest of the
 * command uses.
 */
export function labelsFor(language?: string): MarkdownLabels {
  return /^en\b/i.test(language?.trim() ?? "") ? LABELS_EN : LABELS_JA;
}

/**
 * Whether the spec is runnable from the reviewer's perspective. Live specs
 * are always runnable (no codegen step); a deterministic spec is runnable
 * only once `test.spec.ts` exists.
 */
export function statusLabel(status: PerspectiveStatus, labels: MarkdownLabels): string {
  if (status.mode === "live") return labels.runnable;
  return status.generated ? labels.runnable : labels.notRunnable;
}

/** The spec's execution mode (deterministic or live), per spec.yaml. */
export function modeLabel(status: PerspectiveStatus, labels: MarkdownLabels): string {
  return status.mode === "live" ? labels.modeLive : labels.modeDeterministic;
}

/**
 * Path to a spec.yaml relative to the **root** `.ccqa/perspectives.md`
 * (i.e. relative to the `.ccqa/` dir). Used for the category index links.
 */
function specRelPathFromRoot(featureName: string, specName: string): string {
  return `features/${featureName}/test-cases/${specName}/spec.yaml`;
}

/**
 * Path to a category detail file relative to the **root** `.ccqa/perspectives.md`.
 * The detail file is written to `.ccqa/features/<feature>/perspectives.md`
 * (see `getFeaturePerspectivesMarkdownPath`), so the link must include the
 * `features/` segment — otherwise the category heading link 404s.
 */
function featureDetailRelPathFromRoot(featureName: string): string {
  return `features/${featureName}/perspectives.md`;
}

/**
 * Path to a spec.yaml relative to the **category** detail file
 * `.ccqa/features/<feature>/perspectives.md`. The spec lives alongside under
 * `test-cases/<spec>/`, so the category file links to it directly — which is
 * what makes the link resolve both on GitHub and in a local editor.
 */
function specRelPathFromCategory(specName: string): string {
  return `test-cases/${specName}/spec.yaml`;
}

/**
 * Render the root `.ccqa/perspectives.md`: a category-grouped index of which
 * cases exist. Each feature is a heading (linking to its own detail
 * `perspectives.md`) followed by a row per case — title, status, and a link
 * to that case's spec.yaml. The per-case *detail* (検証内容, preconditions,
 * note) still lives only in the per-category file; the root stays a scannable
 * "what is tested, and where" overview.
 *
 * Pure and deterministic, so the index rendering is easy to unit-test.
 */
export function renderIndexMarkdown(perspectives: Perspectives, labels: MarkdownLabels = LABELS_JA): string {
  const lines: string[] = [];
  lines.push(`# ${labels.indexTitle}`);
  lines.push("");

  for (const feature of perspectives.features) {
    const detailLink = featureDetailRelPathFromRoot(feature.featureName);
    lines.push(`## [${feature.featureName}](${detailLink})`);
    lines.push("");
    lines.push(`| ${labels.caseCol} | ${labels.modeCol} | ${labels.statusCol} | spec |`);
    lines.push("| --- | --- | --- | --- |");
    for (const spec of feature.specs) {
      const specLink = specRelPathFromRoot(feature.featureName, spec.specName);
      const mode = mdCell(modeLabel(spec.status, labels));
      const status = mdCell(statusLabel(spec.status, labels));
      lines.push(`| ${mdCell(spec.title)} | ${mode} | ${status} | [spec](${specLink}) |`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Render one category's `.ccqa/features/<feature>/perspectives.md`: every
 * case in the category as a self-contained vertical table. All columns —
 * including the verification summary (検証内容) and the human note — live
 * inside the table; nothing is emitted outside it. Detailed steps / expected
 * results are still not restated (the spec.yaml is their single home); the
 * table links back to each spec instead.
 *
 * Pure and deterministic, so the per-case rendering is easy to unit-test.
 */
export function renderFeatureMarkdown(feature: PerspectiveFeature, labels: MarkdownLabels = LABELS_JA): string {
  const lines: string[] = [];
  lines.push(`# ${feature.featureName}`);
  lines.push("");

  for (const spec of feature.specs) {
    lines.push(...renderSpecMarkdown(spec, labels));
  }

  return lines.join("\n");
}

/**
 * Render one spec as a single vertical (item | content) Markdown table for a
 * category file. Verification summary and preconditions lead. The spec link
 * is relative to this category file so it resolves both on GitHub and in a
 * local editor. Related-code paths stay inline code rather than links: their
 * base (the cwd that hosts `.ccqa/`) is not reliably recoverable here — specs
 * carry a mix of cwd-relative (`src/...`) and repo-root (`pkg/app/src/...`)
 * forms — and many are globs that no link could open anyway. 検証内容
 * (summary) and note are rows inside the table; no prose blocks are emitted
 * around it. Exported for focused unit testing.
 */
export function renderSpecMarkdown(spec: PerspectiveSpec, labels: MarkdownLabels = LABELS_JA): string[] {
  const lines: string[] = [];
  lines.push(`## ${spec.title}`);
  lines.push("");
  lines.push(`| ${labels.itemCol} | ${labels.valueCol} |`);
  lines.push("| --- | --- |");
  if (spec.summary) lines.push(`| ${labels.summary} | ${mdCell(spec.summary)} |`);
  if (spec.preconditions && spec.preconditions.length > 0) {
    lines.push(`| ${labels.preconditions} | ${spec.preconditions.map(mdCell).join("<br>")} |`);
  }
  if (spec.startScreen) lines.push(`| ${labels.startScreen} | ${mdCell(spec.startScreen)} |`);
  const specPath = specRelPathFromCategory(spec.specName);
  lines.push(`| spec | [${specPath}](${specPath}) |`);
  lines.push(`| ${labels.modeLabel} | ${mdCell(modeLabel(spec.status, labels))} |`);
  lines.push(`| ${labels.statusCol} | ${mdCell(statusLabel(spec.status, labels))} |`);
  if (spec.relatedPaths && spec.relatedPaths.length > 0) {
    lines.push(`| ${labels.relatedCode} | ${spec.relatedPaths.map((p) => `\`${p}\``).join("<br>")} |`);
  }
  if (spec.note) lines.push(`| 📝 note | ${mdCell(spec.note)} |`);
  lines.push("");

  return lines;
}

/** Escape pipes / newlines so a value stays inside one Markdown table cell. */
function mdCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
