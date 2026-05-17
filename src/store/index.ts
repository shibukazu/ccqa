import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { collectIncludedBlockNames } from "../spec/expand.ts";
import { parseBlockSpec, parseTestSpec } from "../spec/parser.ts";
import { isParamRequired } from "../spec/yaml-schema.ts";
import type { BlockSpec, Route, TestSpec, TraceAction } from "../types.ts";

export interface AvailableBlock {
  name: string;
  title: string;
  params: Array<{ name: string; required: boolean; secret: boolean }>;
}

const CCQA_DIR = ".ccqa";
const SPEC_FILE = "spec.yaml";

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

export async function saveRoute(featureName: string, specName: string, route: Route, cwd?: string): Promise<string> {
  const specDir = getSpecDir(featureName, specName, cwd);
  await mkdir(specDir, { recursive: true });
  const routePath = join(specDir, "route.md");
  await writeFile(routePath, routeToMarkdown(route), "utf-8");
  return routePath;
}

export async function saveTraceActions(
  featureName: string,
  specName: string,
  actions: TraceAction[],
  cwd?: string,
): Promise<string> {
  const specDir = getSpecDir(featureName, specName, cwd);
  await mkdir(specDir, { recursive: true });
  const actionsPath = join(specDir, "actions.json");
  await writeFile(actionsPath, JSON.stringify(actions, null, 2), "utf-8");
  return actionsPath;
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
 * block directory holds only spec.yaml — no per-block actions.json / route
 * lives here anymore.)
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

/**
 * Probe for orphaned files left over from earlier ccqa versions inside
 * `.ccqa/blocks/<name>/`. Both pre-v0.4 `test.spec.ts` (function-export
 * blocks) and the short-lived `actions.json` / `route.md` (recorded-block
 * variant) are dead in the new "blocks are pure spec templates" model and
 * should be deleted manually. Returns the absolute paths.
 */
export async function findStaleBlockArtifacts(cwd?: string): Promise<string[]> {
  const dir = getBlocksDir(cwd);
  const names = await readdir(dir).catch(() => [] as string[]);
  const stale = await Promise.all(
    names.flatMap((name) =>
      ["test.spec.ts", "actions.json", "route.md"].map(async (f) => {
        const path = join(dir, name, f);
        const exists = await stat(path).then(() => true).catch(() => false);
        return exists ? path : null;
      }),
    ),
  );
  return stale.filter((p): p is string => p !== null);
}

// --- Trace Actions ---

export async function getTraceActions(
  featureName: string,
  specName: string,
  cwd?: string,
): Promise<{ path: string; actions: TraceAction[] }> {
  const path = join(getSpecDir(featureName, specName, cwd), "actions.json");
  const content = await readFile(path, "utf-8").catch(() => {
    throw new Error(`No trace actions found for spec: ${featureName}/${specName}. Run \`ccqa trace\` first.`);
  });
  return { path, actions: JSON.parse(content) as TraceAction[] };
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
  const featuresDir = join(getCcqaDir(cwd), "features");
  const featureDirs = await readdir(featuresDir).catch(() => []);

  const perFeature = await Promise.all(
    featureDirs.map(async (featureName) => {
      const testCasesDir = join(featuresDir, featureName, "test-cases");
      const specDirs = await readdir(testCasesDir).catch(() => []);
      const entries = await Promise.all(
        specDirs.map(async (specName) => {
          const scriptFile = join(testCasesDir, specName, "test.spec.ts");
          const exists = await stat(scriptFile).then(() => true).catch(() => false);
          return exists ? { featureName, specName } : null;
        }),
      );
      return entries.filter((e): e is { featureName: string; specName: string } => e !== null);
    }),
  );

  return perFeature.flat();
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


export function routeToMarkdown(route: Route): string {
  const lines: string[] = [
    "---",
    `specName: "${route.specName}"`,
    `timestamp: "${route.timestamp}"`,
    `status: "${route.status}"`,
    "---",
    "",
  ];

  for (const step of route.steps) {
    lines.push(`## ${step.title}`);
    lines.push(`- **action**: ${step.action}`);
    lines.push(`- **observation**: ${step.observation}`);
    lines.push(`- **status**: ${step.status}`);
    if (step.reason) lines.push(`- **reason**: ${step.reason}`);
    lines.push("");
  }

  return lines.join("\n");
}
