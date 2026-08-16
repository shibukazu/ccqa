import { accessSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, resolve } from "node:path";
import { describe, expect, test } from "vitest";

import { getRepoRoot } from "../_helpers/cli.ts";

/**
 * Contract test for the `ccqa-tools` entries that run where node's built-ins do
 * not exist.
 *
 * Two of these have already cost a day each. `node:http` reached the package
 * core, and Next's webpack — which pulls the core into every layer it builds —
 * refused the whole build with `UnhandledSchemeError`. Later the bundler
 * hoisted a chunk shared between `register` and the Temporal workflow entry,
 * carrying the Node-only half into the deterministic sandbox, and the worker
 * stopped starting. Nobody had written a built-in import into either file.
 *
 * `tsdown.config.ts` prevents the second one by construction — one config per
 * entry, never a shared chunk. Nothing prevents the first, and a comment
 * saying "import nothing here" is not a check.
 *
 * Read from `dist/`, not from the sources: what the bundler merged in is the
 * whole question, and the sources cannot answer it.
 */

/**
 * Why each of these has to stay free of built-ins. Entries absent from the list
 * — `register`, `next`, `next/loader` — are the Node-only half and may use them.
 */
const CONSTRAINED: Record<string, string> = {
  core: "bundlers pull it into every layer they build, and each rejects a different subset",
  slack: "installed into the application's own request chain, which a bundler may own",
  middleware: "same: the application imports it into its request handling",
  "temporal-workflow": "Temporal evaluates it in a deterministic sandbox with no built-ins",
};

/** Both spellings. `node:fs` and a bare `fs` are the same module to node. */
const BUILT_IN = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);

const repoRoot = getRepoRoot();
const distDir = `${repoRoot}/packages/tools/dist/coverage`;
const requireDist = process.env.CCQA_REQUIRE_DIST === "1";
const distBuilt = (() => {
  try {
    accessSync(`${distDir}/core.js`);
    return true;
  } catch {
    return false;
  }
})();

if (requireDist && !distBuilt) {
  throw new Error(
    `CCQA_REQUIRE_DIST=1 but ${distDir} is missing — run \`pnpm build\` before the E2E suite`,
  );
}

const IMPORT_FROM = /(?:^|[\s;])(?:import|export)[^'"]*?from\s*["']([^"']+)["']/g;
const BARE_IMPORT = /(?:^|[\s;])import\s*["']([^"']+)["']/g;
const REQUIRE = /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;

/** Specifiers the entry imports, and those its own chunks import, transitively. */
function reachedSpecifiers(entry: string): Set<string> {
  const seen = new Set<string>();
  const external = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const code = readFileSync(file, "utf8");
    for (const pattern of [IMPORT_FROM, BARE_IMPORT, REQUIRE]) {
      pattern.lastIndex = 0;
      for (const match of code.matchAll(pattern)) {
        const specifier = match[1]!;
        if (specifier.startsWith(".")) queue.push(resolve(dirname(file), specifier));
        else external.add(specifier);
      }
    }
  }
  return external;
}

describe.skipIf(!distBuilt)("entries that run without node's built-ins", () => {
  for (const [name, why] of Object.entries(CONSTRAINED)) {
    test(name, () => {
      // Both formats: an application may load either, and a bundler decides
      // between them by condition rather than by anything visible here.
      const found = [`${distDir}/${name}.js`, `${distDir}/${name}.cjs`].flatMap((file) =>
        [...reachedSpecifiers(file)].filter((specifier) => BUILT_IN.has(specifier)),
      );
      expect([...new Set(found)], `${name} must import no built-in — ${why}`).toEqual([]);
    });
  }
});
