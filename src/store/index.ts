import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Route, TraceAction } from "../types.ts";

const VERIQ_DIR = ".veriq";

export function getVeriqDir(cwd: string = process.cwd()): string {
  return join(cwd, VERIQ_DIR);
}

// "tasks/create-and-complete" → { featureName: "tasks", specName: "create-and-complete" }
export function parseSpecPath(specPath: string): { featureName: string; specName: string } {
  const parts = specPath.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid spec path: "${specPath}". Expected format: "<feature>/<spec>"`);
  }
  return { featureName: parts[0], specName: parts[1] };
}

export function getFeatureDir(featureName: string, cwd?: string): string {
  return join(getVeriqDir(cwd), "features", featureName);
}

export function getSpecDir(featureName: string, specName: string, cwd?: string): string {
  return join(getFeatureDir(featureName, cwd), "test-cases", specName);
}


export async function ensureVeriqDir(cwd?: string): Promise<void> {
  await mkdir(join(getVeriqDir(cwd), "features"), { recursive: true });
}


export async function readSpecFile(featureName: string, specName: string, cwd?: string): Promise<string> {
  const specPath = join(getSpecDir(featureName, specName, cwd), "test-spec.md");
  return readFile(specPath, "utf-8").catch(() => {
    throw new Error(`Spec file not found: ${specPath}`);
  });
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

// --- Setup (shared procedures) ---

export function getSetupDir(name: string, cwd?: string): string {
  return join(getVeriqDir(cwd), "setups", name);
}

export async function readSetupSpecFile(name: string, cwd?: string): Promise<string> {
  const specPath = join(getSetupDir(name, cwd), "setup-spec.md");
  return readFile(specPath, "utf-8").catch(() => {
    throw new Error(`Setup spec not found: ${specPath}`);
  });
}

export async function saveSetupActions(name: string, actions: TraceAction[], cwd?: string): Promise<string> {
  const dir = getSetupDir(name, cwd);
  await mkdir(dir, { recursive: true });
  const path = join(dir, "actions.json");
  await writeFile(path, JSON.stringify(actions, null, 2), "utf-8");
  return path;
}

export async function getSetupActions(name: string, cwd?: string): Promise<{ path: string; actions: TraceAction[] }> {
  const path = join(getSetupDir(name, cwd), "actions.json");
  const content = await readFile(path, "utf-8").catch(() => {
    throw new Error(`No setup actions found for: ${name}. Run \`veriq trace-setup ${name}\` first.`);
  });
  return { path, actions: JSON.parse(content) as TraceAction[] };
}

export async function saveSetupRoute(name: string, route: Route, cwd?: string): Promise<string> {
  const dir = getSetupDir(name, cwd);
  await mkdir(dir, { recursive: true });
  const routePath = join(dir, "route.md");
  await writeFile(routePath, routeToMarkdown(route), "utf-8");
  return routePath;
}

export async function saveSetupTestScript(name: string, content: string, cwd?: string): Promise<string> {
  const dir = getSetupDir(name, cwd);
  await mkdir(dir, { recursive: true });
  const path = join(dir, "test.spec.ts");
  await writeFile(path, content, "utf-8");
  return path;
}

export async function removeSetupTestScript(name: string, cwd?: string): Promise<void> {
  const path = join(getSetupDir(name, cwd), "test.spec.ts");
  const { unlink } = await import("node:fs/promises");
  await unlink(path).catch(() => {});
}

// --- Trace Actions ---

export async function getTraceActions(
  featureName: string,
  specName: string,
  cwd?: string,
): Promise<{ path: string; actions: TraceAction[] }> {
  const path = join(getSpecDir(featureName, specName, cwd), "actions.json");
  const content = await readFile(path, "utf-8").catch(() => {
    throw new Error(`No trace actions found for spec: ${featureName}/${specName}. Run \`veriq trace\` first.`);
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
  const featuresDir = join(getVeriqDir(cwd), "features");
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
