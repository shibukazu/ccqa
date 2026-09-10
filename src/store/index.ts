import { RunUsageError } from "../run/errors.ts";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { collectIncludedBlockNames } from "../spec/expand.ts";
import { parseBlockSpec, parseTestSpec, tryParseTestSpec } from "../spec/parser.ts";
import { isParamRequired } from "../spec/yaml-schema.ts";
import type { BlockSpec, RecordedAction } from "../types.ts";
import type { HubContext } from "../cli/hub-conn.ts";
import type { GuidanceKind, PromptName } from "../prompts/prompt-names.ts";

export interface AvailableBlock {
  name: string;
  title: string;
  params: Array<{ name: string; required: boolean; secret: boolean }>;
}

const CCQA_DIR = ".ccqa";
/** Where a case whose intent lives outside `.ccqa/` keeps its own files. */
const CASES_DIR = "cases";
const SPEC_FILE = "spec.yaml";
/**
 * The spec directory as a path template (see src/targets/test-path.ts). Kept
 * here beside `getSpecDir` so the `.ccqa` layout has one spelling: a target's
 * `defaultTestPath` and the store's own paths cannot drift apart.
 */
export const SPEC_DIR_TEMPLATE = `${CCQA_DIR}/features/{feature}/test-cases/{spec}`;
/** The vitest test the agent-browser target compiles a recording into. */
export const TEST_SCRIPT_FILE = "test.spec.ts";
const RECORDING_FILE = "ir.json";
// Where a FAILED trace's actions land — see saveFailedRecording.
const FAILED_RECORDING_FILE = "ir.failed.json";
// What `ccqa record` writes when it replaced an existing recording.
const ROUTE_DIFF_FILE = "route-diff.md";
// What the last generation's review of the test found, per step.
const REVIEW_FILE = "review.json";
const PERSPECTIVES_FILE = "perspectives.yaml";
const PERSPECTIVES_MD_FILE = "perspectives.md";

export function getCcqaDir(cwd: string = process.cwd()): string {
  return join(cwd, CCQA_DIR);
}

/**
 * Accepts both the canonical 2-segment alias and the on-disk 4-segment path
 * (which is what shell tab-completion produces):
 *   - "tasks/create-and-complete"
 *   - "features/tasks/test-cases/create-and-complete"
 *   - ".ccqa/features/tasks/test-cases/create-and-complete"
 * All forms resolve to { featureName: "tasks", specName: "create-and-complete" }.
 * Trailing slashes are tolerated.
 */
export interface SpecRef {
  featureName: string;
  specName: string;
}

export function specKey(ref: SpecRef): string {
  return `${ref.featureName}/${ref.specName}`;
}

export function parseSpecPath(specPath: string): SpecRef {
  const cleaned = specPath.replace(/^\.\/+/, "").replace(/\/+$/, "");
  const parts = cleaned.split("/").filter((p) => p.length > 0);

  // Strip an optional leading ".ccqa".
  if (parts[0] === ".ccqa") parts.shift();

  // 4-segment on-disk form: features/<feature>/test-cases/<spec>
  if (parts.length === 4 && parts[0] === "features" && parts[2] === "test-cases") {
    return { featureName: parts[1]!, specName: parts[3]! };
  }

  // 2-segment alias: <feature>/<spec>
  if (parts.length === 2 && parts[0] && parts[1]) {
    return { featureName: parts[0], specName: parts[1] };
  }

  // A usage error, not a crash: every caller of this is a CLI argument, so an
  // unrecognised shape is the operator mistyping it. As a plain Error it
  // escaped the commands' `withUsageErrors` boundary and printed a stack trace.
  throw new RunUsageError(
    `Invalid spec path: "${specPath}". Expected "<feature>/<spec>" ` +
      `or "features/<feature>/test-cases/<spec>".`,
  );
}

export function getFeatureDir(featureName: string, cwd?: string): string {
  return join(getCcqaDir(cwd), "features", featureName);
}

export function getSpecDir(featureName: string, specName: string, cwd?: string): string {
  return join(getFeatureDir(featureName, cwd), "test-cases", specName);
}

/**
 * One test case's own working directory — where its recording, its route diff
 * and its lock live.
 *
 * A case's intent comes from one of two places: ccqa's own `spec.yaml`, whose
 * directory is also the case's, or a file in the consumer's repository (a
 * markdown test case), which keeps nothing of ccqa's beside it. The second
 * kind gets a directory under `.ccqa/cases/<id>`, mirroring the path the case
 * has in the project — so what ccqa keeps about a case is findable from the
 * case, and the consumer's own tree stays theirs.
 */
export interface CaseRef {
  /** `<feature>/<spec>`, or the intent source's path-shaped id. */
  id: string;
  /** Absolute working directory. */
  dir: string;
}

export function specCase(featureName: string, specName: string, cwd?: string): CaseRef {
  return { id: `${featureName}/${specName}`, dir: getSpecDir(featureName, specName, cwd) };
}

/**
 * A case id as the report rows and the hub still spell one: a feature and a
 * spec. An intent id has more segments than that — its last is the case, and
 * everything before it is where the project files it.
 */
export function splitCaseId(id: string): { featureName: string; specName: string } {
  const parts = id.split("/");
  const specName = parts.pop()!;
  return { featureName: parts.join("/") || specName, specName };
}

/** The case an intent source names, by its root-relative id (no extension). */
export function intentCase(id: string, cwd?: string): CaseRef {
  return { id, dir: join(getCcqaDir(cwd), CASES_DIR, ...id.split("/")) };
}


export async function ensureCcqaDir(cwd?: string): Promise<void> {
  await mkdir(join(getCcqaDir(cwd), "features"), { recursive: true });
  await mkdir(join(getCcqaDir(cwd), "blocks"), { recursive: true });
}


export async function readSpecFile(featureName: string, specName: string, cwd?: string): Promise<string> {
  const specPath = join(getSpecDir(featureName, specName, cwd), SPEC_FILE);
  return readFile(specPath, "utf-8").catch(() => {
    throw new Error(`Spec file not found: ${specPath}`);
  });
}

export async function tryReadSpecFile(
  featureName: string,
  specName: string,
  cwd?: string,
): Promise<string | null> {
  const specPath = join(getSpecDir(featureName, specName, cwd), SPEC_FILE);
  return readFile(specPath, "utf-8").catch(() => null);
}

export async function saveSpecFile(
  featureName: string,
  specName: string,
  content: string,
  cwd?: string,
): Promise<string> {
  const specDir = getSpecDir(featureName, specName, cwd);
  await mkdir(specDir, { recursive: true });
  const specPath = join(specDir, SPEC_FILE);
  const normalized = content.endsWith("\n") ? content : content + "\n";
  await writeFile(specPath, normalized, "utf-8");
  return specPath;
}

// --- Perspectives (repo-wide coverage inventory, stored on the hub) ---

/**
 * The perspectives document now lives on the hub only. Earlier versions wrote
 * it into the repo as `.ccqa/perspectives.yaml` + `.ccqa/perspectives.md` +
 * `.ccqa/features/<feature>/perspectives.md`; remove any of those leftovers.
 * Returns the paths that were actually deleted.
 */
export async function removeLegacyPerspectivesFiles(cwd?: string): Promise<string[]> {
  const candidates = [
    join(getCcqaDir(cwd), PERSPECTIVES_FILE),
    join(getCcqaDir(cwd), PERSPECTIVES_MD_FILE),
  ];
  const featuresDir = join(getCcqaDir(cwd), "features");
  const featureNames = await readdir(featuresDir).catch(() => [] as string[]);
  for (const name of featureNames) {
    candidates.push(join(featuresDir, name, PERSPECTIVES_MD_FILE));
  }
  const removed: string[] = [];
  for (const path of candidates) {
    const deleted = await unlink(path).then(() => true).catch(() => false);
    if (deleted) removed.push(path);
  }
  return removed;
}

/**
 * What `ir.json` holds: the route a recording actually took, plus the minimum
 * needed to say where it came from.
 *
 * The actions are the route — every operation, locator, value and check the
 * trace performed. The provenance is what makes the route auditable a month
 * later: `recordedAt` dates it, and `origin` says which entry point it started
 * from, with `${VAR}` references left unexpanded so the recording still reads
 * the same across environments.
 */
export interface Recording {
  actions: RecordedAction[];
  /** ISO8601 timestamp of the trace that produced this route. */
  recordedAt?: string;
  /** The route's first navigation, `${VAR}` refs intact. */
  origin?: string;
  /**
   * The undo the case states, recorded in the same session as the route and
   * kept apart from it: what a test does and what it takes back are emitted to
   * different places, and only the recording knows which actions were which.
   */
  cleanup?: RecordedAction[];
  /**
   * What the last `ccqa generate` wrote from this route. The one thing that
   * can tell a hand edit from a regeneration: `ccqa generate` re-stamps it, so
   * a test it produced still matches, and only someone else's edit does not.
   *
   * It lives here, on a file the consumer already commits, rather than in a
   * ledger of its own — and only `ccqa generate` reads it. The audit and the
   * run never do: the generated test belongs to the consumer, and neither
   * command's answer may depend on who last wrote it.
   */
  generated?: { testSha256: string; at: string };
}

/** Hex sha256 of a file's bytes, or null when it is not there to read. */
export async function fileSha256(pathAbs: string): Promise<string | null> {
  const bytes = await readFile(pathAbs).catch(() => null);
  return bytes === null ? null : createHash("sha256").update(bytes).digest("hex");
}

/**
 * Record what this generation wrote, leaving the route itself untouched. A
 * recording with no test to stamp keeps whatever stamp it had: the generation
 * produced nothing to attribute.
 */
export async function stampGeneratedTest(
  ref: CaseRef,
  testPathAbs: string,
): Promise<void> {
  const path = getRecordingPath(ref);
  const content = await readFile(path, "utf-8").catch(() => null);
  const testSha256 = await fileSha256(testPathAbs);
  if (content === null || testSha256 === null) return;
  const recording = parseRecording(content);
  recording.generated = { testSha256, at: new Date().toISOString() };
  await writeFile(path, JSON.stringify(recording, null, 2), "utf-8");
}

function buildRecording(actions: RecordedAction[], cleanup: RecordedAction[] = []): Recording {
  const origin = actions.find((a) => a.action === "navigate")?.value;
  return {
    recordedAt: new Date().toISOString(),
    ...(origin ? { origin } : {}),
    actions,
    ...(cleanup.length > 0 ? { cleanup } : {}),
  };
}

/**
 * Parse `ir.json`. A recording written before the file carried provenance is a
 * bare action array; it still describes a route, so it is read as one with the
 * provenance simply absent rather than rejected.
 */
export function parseRecording(content: string): Recording {
  const parsed: unknown = JSON.parse(content);
  if (Array.isArray(parsed)) return { actions: parsed as RecordedAction[] };
  const recording = parsed as Partial<Recording>;
  if (!Array.isArray(recording.actions)) {
    // Truncated or hand-mangled: say so here, where the file is named, rather
    // than downstream where a missing action list reads as a code bug.
    throw new Error("ir.json holds no `actions` array — re-run `ccqa record`");
  }
  return recording as Recording;
}

// Per-spec artifacts written by pre-IR ccqa versions, superseded by ir.json.
// Removed on every save so a re-record leaves no stale files behind.
const LEGACY_RECORDING_FILES = ["actions.json", "route.md"];

export async function saveRecording(
  ref: CaseRef,
  actions: RecordedAction[],
  cleanup: RecordedAction[] = [],
): Promise<{ path: string; recording: Recording }> {
  await mkdir(ref.dir, { recursive: true });
  const recordingPath = join(ref.dir, RECORDING_FILE);
  const recording = buildRecording(actions, cleanup);
  await writeFile(recordingPath, JSON.stringify(recording, null, 2), "utf-8");
  await Promise.all(
    // A successful save also removes a leftover failed-trace file: it
    // described an older attempt, and keeping it beside a good ir.json
    // reads as an open problem.
    [...LEGACY_RECORDING_FILES, FAILED_RECORDING_FILE].map((f) =>
      unlink(join(ref.dir, f)).catch(() => {}),
    ),
  );
  return { path: recordingPath, recording };
}

/** Where `ccqa record` leaves the route diff against the previous recording. */
export async function saveRouteDiff(ref: CaseRef, markdown: string): Promise<string> {
  const path = join(ref.dir, ROUTE_DIFF_FILE);
  await writeFile(path, markdown, "utf-8");
  return path;
}

/**
 * Keep what the review of the generated test found, so the evidence table can
 * show it per step rather than a reader having to scroll a generate log.
 * `findings: null` means no review was obtained, which the record keeps apart
 * from a clean one.
 */
export async function saveSpecReview(ref: CaseRef, review: unknown): Promise<string> {
  await mkdir(ref.dir, { recursive: true });
  const path = join(ref.dir, REVIEW_FILE);
  await writeFile(path, JSON.stringify(review, null, 2) + "\n", "utf-8");
  return path;
}

/** The last review of this case's generated test, or null when there is none. */
export async function readSpecReview(ref: CaseRef): Promise<unknown | null> {
  const raw = await readFile(join(ref.dir, REVIEW_FILE), "utf-8").catch(() => null);
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Drop the route diff — there is no previous recording for it to describe. */
export async function removeRouteDiff(ref: CaseRef): Promise<void> {
  await unlink(join(ref.dir, ROUTE_DIFF_FILE)).catch(() => {});
}

/**
 * Persist the actions of a trace that FAILED. They go to a side file so a
 * recording that did not demonstrate the spec can never replace one that
 * did — `ir.json` and the generated code stay whatever they were. The next
 * successful {@link saveRecording} deletes the file.
 */
export async function saveFailedRecording(
  ref: CaseRef,
  actions: RecordedAction[],
): Promise<string> {
  await mkdir(ref.dir, { recursive: true });
  const path = join(ref.dir, FAILED_RECORDING_FILE);
  await writeFile(path, JSON.stringify(buildRecording(actions), null, 2), "utf-8");
  return path;
}

// --- Blocks (reusable shared procedures) ---

export function getBlocksDir(cwd?: string): string {
  return join(getCcqaDir(cwd), "blocks");
}

export function getBlockDir(name: string, cwd?: string): string {
  return join(getBlocksDir(cwd), name);
}

/**
 * Inverse of `getBlockDir`. Given a file path that appears in a git diff,
 * return the block name if the path points at the block's spec.yaml, else
 * null. Used by `audit --only-affected-by` to invalidate specs whose included blocks
 * were edited. (v0.4 inlines blocks into every spec's own trace, so the
 * block directory holds only spec.yaml — no per-block recording lives
 * here anymore.)
 */
export function parseBlockPath(path: string): string | null {
  const match = path.match(/(?:^|\/)\.ccqa\/blocks\/([^/]+)\/spec\.yaml$/);
  return match?.[1] ?? null;
}

/**
 * Load every block under `.ccqa/blocks/<name>/spec.yaml`. Used by the trace /
 * generate / drift entry points to validate include references at parse time.
 *
 * A malformed block is fatal — surfaces as a thrown Error with the path that
 * failed. Missing block directories (no `spec.yaml`) are silently skipped so
 * stray files don't break the loader.
 */
export async function loadAllBlocks(cwd?: string): Promise<Map<string, BlockSpec>> {
  const dir = getBlocksDir(cwd);
  const names = await readdir(dir).catch(() => [] as string[]);
  const entries = await Promise.all(
    names.map(async (name): Promise<[string, BlockSpec] | null> => {
      const path = join(dir, name, SPEC_FILE);
      const content = await readFile(path, "utf-8").catch(() => null);
      return content === null ? null : [name, parseBlockSpec(content, path)];
    }),
  );
  return new Map(entries.filter((e): e is [string, BlockSpec] => e !== null));
}

/**
 * Project the parsed blocks into the shape the draft / drift prompts consume.
 * Co-located with `loadAllBlocks` so callers don't have to remember the
 * isParamRequired / secret-default mapping.
 */
export function projectAvailableBlocks(blocks: Map<string, BlockSpec>): AvailableBlock[] {
  return [...blocks.entries()].map(([name, block]) => ({
    name,
    title: block.title,
    params: (block.params ?? []).map((p) => ({
      name: p.name,
      required: isParamRequired(p),
      secret: p.secret === true,
    })),
  }));
}

/** `loadAllBlocks` + `projectAvailableBlocks`, for callers that need only the projection. */
export async function loadAvailableBlocks(cwd?: string): Promise<AvailableBlock[]> {
  return projectAvailableBlocks(await loadAllBlocks(cwd));
}

export async function readBlockSpec(name: string, cwd?: string): Promise<BlockSpec> {
  const path = join(getBlockDir(name, cwd), SPEC_FILE);
  const content = await readFile(path, "utf-8").catch(() => {
    throw new Error(`Block spec not found: ${path}`);
  });
  return parseBlockSpec(content, path);
}

const USER_PROMPT_MAX_BYTES = 32_768;

export interface PromptBundle {
  /** Final concatenated string to append after the system prompt prefix, or null when nothing was loaded. */
  text: string;
  /** Sources actually loaded (hub prompt names), for logging. */
  loaded: string[];
}

/**
 * Load the prompt bundle from the hub for one guidance kind ("record" /
 * "live" / an LLM-generation target such as "playwright" or "runn").
 * Best-effort: no hub client, a fetch failure, or both prompts absent all
 * A prompt that was never stored resolves to null. A hub that cannot be
 * reached throws: running with silently different guidance than the project
 * configured is worse than stopping.
 */
export async function loadPromptBundleFromHub(
  ctx: HubContext | null,
  kind: GuidanceKind,
): Promise<PromptBundle | null> {
  if (!ctx) return null;
  const userName: PromptName = `${kind}.user`;
  const agentName: PromptName = `${kind}.agent`;
  const [userText, agentText] = await Promise.all([
    ctx.hub.getPrompt(ctx.project, userName).then(normalizePromptText),
    ctx.hub.getPrompt(ctx.project, agentName).then(normalizePromptText),
  ]);
  return assemblePromptBundle(
    { text: userText, label: userName },
    { text: agentText, label: agentName },
  );
}

/**
 * Shared concatenation logic behind `loadPromptBundleFromHub`: section
 * headers, `loaded` labels, and the 32 KiB cap. Returns null when both
 * inputs are absent.
 */
function assemblePromptBundle(
  user: { text: string | null; label: string },
  agent: { text: string | null; label: string },
): PromptBundle | null {
  if (user.text === null && agent.text === null) return null;
  const sections: string[] = [];
  const loaded: string[] = [];
  if (user.text !== null) {
    sections.push(`### Project guidance (human-maintained)\n\n${user.text}`);
    loaded.push(user.label);
  }
  if (agent.text !== null) {
    sections.push(`### Agent learnings (auto-updated by ccqa's --learn-*-prompt flags)\n\n${agent.text}`);
    loaded.push(agent.label);
  }
  let text = sections.join("\n\n");
  if (text.length > USER_PROMPT_MAX_BYTES) {
    text = text.slice(0, USER_PROMPT_MAX_BYTES) +
      `\n\n[ccqa] (prompt bundle truncated at ${USER_PROMPT_MAX_BYTES} bytes)`;
  }
  return { text, loaded };
}

/** Trim + empty-string-to-null normalization applied to hub prompt sources. */
function normalizePromptText(content: string | null): string | null {
  if (content === null) return null;
  const trimmed = content.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Probe for orphaned files left over from earlier ccqa versions inside
 * `.ccqa/blocks/<name>/`. Both pre-v0.4 `test.spec.ts` (function-export
 * blocks) and the short-lived `actions.json` (recorded-block variant) are
 * dead in the new "blocks are pure spec templates" model and should be
 * deleted manually. Returns the absolute paths.
 */
export async function findStaleBlockArtifacts(cwd?: string): Promise<string[]> {
  const dir = getBlocksDir(cwd);
  const names = await readdir(dir).catch(() => [] as string[]);
  const stale = await Promise.all(
    names.flatMap((name) =>
      ["test.spec.ts", "actions.json"].map(async (f) => {
        const path = join(dir, name, f);
        const exists = await stat(path).then(() => true).catch(() => false);
        return exists ? path : null;
      }),
    ),
  );
  return stale.filter((p): p is string => p !== null);
}

// --- Recordings (IR) ---

export function getRecordingPath(ref: CaseRef): string {
  return join(ref.dir, RECORDING_FILE);
}

export async function getRecording(ref: CaseRef): Promise<Recording & { path: string }> {
  const path = getRecordingPath(ref);
  const content = await readFile(path, "utf-8").catch(() => {
    throw new Error(`No recording found for: ${ref.id}. Run \`ccqa record\` first.`);
  });
  return { path, ...parseRecording(content) };
}

/** The saved recording, or null when the spec has none. */
export async function tryGetRecording(ref: CaseRef): Promise<Recording | null> {
  const content = await readFile(getRecordingPath(ref), "utf-8").catch(() => null);
  return content === null ? null : parseRecording(content);
}

export async function saveTestScript(
  featureName: string,
  specName: string,
  content: string,
  cwd?: string,
): Promise<string> {
  const specDir = getSpecDir(featureName, specName, cwd);
  await mkdir(specDir, { recursive: true });
  const scriptPath = join(specDir, TEST_SCRIPT_FILE);
  await writeFile(scriptPath, content, "utf-8");
  return scriptPath;
}

export async function getTestScript(featureName: string, specName: string, cwd?: string): Promise<string | null> {
  const path = join(getSpecDir(featureName, specName, cwd), TEST_SCRIPT_FILE);
  return stat(path).then(() => path).catch(() => null);
}

export async function listAllSpecs(cwd?: string): Promise<Array<{ featureName: string; specName: string }>> {
  return listAllSpecsFilteredBy(TEST_SCRIPT_FILE, cwd);
}

/**
 * Variant of `listAllSpecs` for callers that care about the spec definition
 * itself (spec.yaml) rather than its compiled vitest script. `ccqa run` uses
 * this for live-mode specs because they skip codegen entirely — a freshly
 * drafted spec with no `test.spec.ts` is still a valid target.
 */
export async function listAllSpecsWithSpecFile(cwd?: string): Promise<Array<{ featureName: string; specName: string }>> {
  return listAllSpecsFilteredBy(SPEC_FILE, cwd);
}

/**
 * The active suite — the tree minus the specs marked `disabled` — which is
 * what `ccqa run` expands "all specs" to. Kept separate from the enumeration
 * above because `serialGroups` and `actors` validate that a spec *name*
 * exists, and a disabled spec is still a name.
 *
 * A spec that will not read or parse stays in: unreadable is not the same as
 * asking to be skipped.
 */
export async function listActiveSpecs(cwd?: string): Promise<SpecRef[]> {
  const all = await listAllSpecsWithSpecFile(cwd);
  const kept = await Promise.all(
    all.map(async (ref) => {
      const spec = tryParseTestSpec(await tryReadSpecFile(ref.featureName, ref.specName, cwd));
      return spec?.disabled === true ? null : ref;
    }),
  );
  return kept.filter((ref) => ref !== null);
}

async function listAllSpecsFilteredBy(
  requiredFilename: string,
  cwd: string | undefined,
): Promise<Array<{ featureName: string; specName: string }>> {
  const featuresDir = join(getCcqaDir(cwd), "features");
  const featureDirs = await readdir(featuresDir).catch(() => []);

  const perFeature = await Promise.all(
    featureDirs.map(async (featureName) => {
      const testCasesDir = join(featuresDir, featureName, "test-cases");
      const specDirs = await readdir(testCasesDir).catch(() => []);
      const entries = await Promise.all(
        specDirs.map(async (specName) => {
          const required = join(testCasesDir, specName, requiredFilename);
          const exists = await stat(required).then(() => true).catch(() => false);
          return exists ? { featureName, specName } : null;
        }),
      );
      return entries.filter((e): e is { featureName: string; specName: string } => e !== null);
    }),
  );

  return perFeature.flat();
}

/**
 * Resolve a CLI `<target>` argument into a list of spec refs. Used by
 * `ccqa run`. Callers pass the right enumerator for "no target" (deterministic
 * specs want `test.spec.ts`-having specs; live specs want `spec.yaml`-having
 * specs).
 */
export async function resolveSpecTargets(
  target: string | undefined,
  enumerateAll: () => Promise<Array<{ featureName: string; specName: string }>>,
  cwd?: string,
): Promise<Array<{ featureName: string; specName: string }>> {
  if (!target) return enumerateAll();
  if (target.includes("/")) {
    const { featureName, specName } = parseSpecPath(target);
    return [{ featureName, specName }];
  }
  // A feature name is a group, so it expands the same way "all specs" does —
  // and a suite narrowed to a few specs would come undone the moment someone
  // ran the feature they live in. Only a spec id names one spec.
  const active = await listActiveSpecs(cwd);
  return active.filter((ref) => ref.featureName === target);
}

export async function listSpecsForFeature(featureName: string, cwd?: string): Promise<string[]> {
  const testCasesDir = join(getFeatureDir(featureName, cwd), "test-cases");
  return readdir(testCasesDir).catch(() => []);
}

export interface FeatureTreeSpec {
  specName: string;
  hasSpecFile: boolean;
  /** Names of blocks this spec includes. Empty array when none. */
  includedBlocks?: string[];
}

export interface FeatureTreeEntry {
  featureName: string;
  specs: FeatureTreeSpec[];
}

/**
 * Lists every feature/spec dir under .ccqa/features/, regardless of whether
 * the spec is fully drafted yet. Each spec file is read at most once.
 */
export async function listFeatureTree(cwd?: string): Promise<FeatureTreeEntry[]> {
  const featuresDir = join(getCcqaDir(cwd), "features");
  const featureDirs = await readdir(featuresDir).catch(() => []);

  return Promise.all(
    featureDirs.map(async (featureName): Promise<FeatureTreeEntry> => {
      const testCasesDir = join(featuresDir, featureName, "test-cases");
      const specDirs = await readdir(testCasesDir).catch(() => []);
      const specs = await Promise.all(
        specDirs.map(async (specName): Promise<FeatureTreeSpec> => {
          const specFile = join(testCasesDir, specName, SPEC_FILE);
          const content = await readFile(specFile, "utf-8").catch(() => null);
          if (content === null) return { specName, hasSpecFile: false };
          try {
            const spec = parseTestSpec(content, specFile);
            return {
              specName,
              hasSpecFile: true,
              includedBlocks: collectIncludedBlockNames(spec),
            };
          } catch {
            return { specName, hasSpecFile: true };
          }
        }),
      );
      return { featureName, specs };
    }),
  );
}
