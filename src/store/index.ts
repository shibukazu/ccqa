import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { collectIncludedBlockNames } from "../spec/expand.ts";
import { parseBlockSpec, parseTestSpec } from "../spec/parser.ts";
import { isParamRequired } from "../spec/yaml-schema.ts";
import type { BlockSpec, RecordedAction, TestSpec } from "../types.ts";
import type { HubContext } from "../cli/hub-conn.ts";
import type { GuidanceKind, PromptName } from "../prompts/prompt-names.ts";

export interface AvailableBlock {
  name: string;
  title: string;
  params: Array<{ name: string; required: boolean; secret: boolean }>;
}

const CCQA_DIR = ".ccqa";
const SPEC_FILE = "spec.yaml";
const RECORDING_FILE = "ir.json";
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

  throw new Error(
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
 * Replace (or insert) the `relatedPaths` key in the spec. Preserves every
 * other top-level field and the entire steps array. Returns the absolute
 * path that was written, or null if the spec file does not exist.
 */
export async function updateSpecRelatedPaths(
  featureName: string,
  specName: string,
  relatedPaths: string[],
  cwd?: string,
): Promise<string | null> {
  const specPath = join(getSpecDir(featureName, specName, cwd), SPEC_FILE);
  const existing = await readFile(specPath, "utf-8").catch(() => null);
  if (existing === null) return null;

  // Round-trip through our parser so we don't accidentally drop or reorder
  // fields. parseTestSpec throws on invalid specs — by the time we get here
  // the file has already been validated upstream (trace reads it before
  // emitting RELATED_PATHS), so a re-parse should succeed.
  const spec = parseTestSpec(existing, specPath);
  const next: TestSpec = {
    ...spec,
    relatedPaths: relatedPaths.length > 0 ? relatedPaths : undefined,
  };
  // Drop undefined keys so `yaml` doesn't serialise `relatedPaths: null`.
  const serialised = stringifyYaml(stripUndefined(next), { lineWidth: 0 });
  await writeFile(specPath, serialised, "utf-8");
  return specPath;
}

function stripUndefined<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out as T;
}

// Per-spec artifacts written by pre-IR ccqa versions, superseded by ir.json.
// Removed on every save so a re-record leaves no stale files behind.
const LEGACY_RECORDING_FILES = ["actions.json", "route.md"];

export async function saveRecording(
  featureName: string,
  specName: string,
  actions: RecordedAction[],
  cwd?: string,
): Promise<string> {
  const specDir = getSpecDir(featureName, specName, cwd);
  await mkdir(specDir, { recursive: true });
  const recordingPath = join(specDir, RECORDING_FILE);
  await writeFile(recordingPath, JSON.stringify(actions, null, 2), "utf-8");
  await Promise.all(
    LEGACY_RECORDING_FILES.map((f) => unlink(join(specDir, f)).catch(() => {})),
  );
  return recordingPath;
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
 * null. Used by `drift --changed` to invalidate specs whose included blocks
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
export async function loadAvailableBlocks(cwd?: string): Promise<AvailableBlock[]> {
  const blocks = await loadAllBlocks(cwd);
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
 * resolve to null — a broken/missing hub prompt must never stop a run.
 */
export async function loadPromptBundleFromHub(
  ctx: HubContext | null,
  kind: GuidanceKind,
): Promise<PromptBundle | null> {
  if (!ctx) return null;
  const userName: PromptName = `${kind}.user`;
  const agentName: PromptName = `${kind}.agent`;
  try {
    const [userText, agentText] = await Promise.all([
      ctx.hub.getPrompt(ctx.project, userName).then(normalizePromptText),
      ctx.hub.getPrompt(ctx.project, agentName).then(normalizePromptText),
    ]);
    return assemblePromptBundle(
      { text: userText, label: userName },
      { text: agentText, label: agentName },
    );
  } catch {
    return null;
  }
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
    sections.push(`### Agent learnings (auto-updated by ccqa --update-agent-prompt)\n\n${agent.text}`);
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

export async function getRecording(
  featureName: string,
  specName: string,
  cwd?: string,
): Promise<{ path: string; actions: RecordedAction[] }> {
  const path = join(getSpecDir(featureName, specName, cwd), RECORDING_FILE);
  const content = await readFile(path, "utf-8").catch(() => {
    throw new Error(`No recording found for spec: ${featureName}/${specName}. Run \`ccqa record\` first.`);
  });
  return { path, actions: JSON.parse(content) as RecordedAction[] };
}

export async function saveTestScript(
  featureName: string,
  specName: string,
  content: string,
  cwd?: string,
): Promise<string> {
  const specDir = getSpecDir(featureName, specName, cwd);
  await mkdir(specDir, { recursive: true });
  const scriptPath = join(specDir, "test.spec.ts");
  await writeFile(scriptPath, content, "utf-8");
  return scriptPath;
}

export async function getTestScript(featureName: string, specName: string, cwd?: string): Promise<string | null> {
  const path = join(getSpecDir(featureName, specName, cwd), "test.spec.ts");
  return stat(path).then(() => path).catch(() => null);
}

export async function listAllSpecs(cwd?: string): Promise<Array<{ featureName: string; specName: string }>> {
  return listAllSpecsFilteredBy("test.spec.ts", cwd);
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
  const names = await listSpecsForFeature(target, cwd);
  return names.map((specName) => ({ featureName: target, specName }));
}

export async function listSpecsForFeature(featureName: string, cwd?: string): Promise<string[]> {
  const testCasesDir = join(getFeatureDir(featureName, cwd), "test-cases");
  return readdir(testCasesDir).catch(() => []);
}

export interface FeatureTreeSpec {
  specName: string;
  hasSpecFile: boolean;
  /** Absent when the spec file is missing or the field is omitted. */
  relatedPaths?: string[];
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
            const entry: FeatureTreeSpec = {
              specName,
              hasSpecFile: true,
              includedBlocks: collectIncludedBlockNames(spec),
            };
            if (spec.relatedPaths) entry.relatedPaths = spec.relatedPaths;
            return entry;
          } catch {
            return { specName, hasSpecFile: true };
          }
        }),
      );
      return { featureName, specs };
    }),
  );
}
