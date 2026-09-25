import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * The consumer's Playwright, not a dependency of ccqa's: its browser and its
 * trace viewer have to match the version the tests run with.
 *
 * Under pnpm's isolation `playwright-core` may only be reachable through
 * `@playwright/test` → `playwright`, so each link is resolved from the one
 * before, skipping links a project does not have. `dirs` are tried in order —
 * nearest first, since in a monorepo only the e2e package may have Playwright.
 */
export async function loadPlaywright<Chromium>(
  dirs: readonly string[],
): Promise<{ coreDir: string; chromium: Chromium }> {
  for (const dir of dirs) {
    const coreDir = resolveCoreDir(dir);
    if (coreDir === null) continue;
    const entry = createRequire(join(coreDir, "package.json")).resolve("playwright-core");
    const mod = (await import(pathToFileURL(entry).href)) as {
      chromium?: Chromium;
      default?: { chromium?: Chromium };
    };
    const chromium = mod.chromium ?? mod.default?.chromium;
    if (chromium !== undefined) return { coreDir, chromium };
  }
  throw new Error(`Playwright is not installed in ${dirs.join(" or ")}`);
}

function resolveCoreDir(dir: string): string | null {
  let from = dir;
  for (const name of ["@playwright/test", "playwright", "playwright-core"]) {
    try {
      from = dirname(createRequire(join(from, "package.json")).resolve(`${name}/package.json`));
      if (name === "playwright-core") return from;
    } catch {
      // A missing link; the next one may still resolve from here.
    }
  }
  return null;
}
