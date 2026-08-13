import { accessSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, test } from "vitest";

import { getRepoRoot } from "../_helpers/cli.ts";

/**
 * Contract test for the subpaths ccqa injects into a consumer's tests.
 *
 * `ccqa/coverage-hooks` and `ccqa/step-evidence` are imported by generated
 * tests and run inside the consumer's test process — a process that installed
 * `ccqa` and nothing ccqa depends on. Anything either of them reaches has to
 * be node's own, or the consumer's suite fails to resolve a module it never
 * asked for.
 *
 * The build does not enforce this. `tsdown.config.ts` emits every entry from
 * one config, so the bundler is free to hoist shared code into a chunk both the
 * CLI binary and an injected subpath import — and the CLI half pulls in zod and
 * the logger. `packages/tools/tsdown.config.ts` prevents the same hazard by
 * building each entry alone, and says why; this is the CLI side's version of
 * that guard, after the fact rather than by construction.
 *
 * Skipped when dist/ is absent so the suite runs without a mandatory build; CI
 * sets CCQA_REQUIRE_DIST=1 after `pnpm build`, where a missing dist/ fails.
 */

const INJECTED = ["coverage-hooks", "step-evidence"];

const repoRoot = getRepoRoot();
const distDir = `${repoRoot}/dist/runtime`;
const requireDist = process.env.CCQA_REQUIRE_DIST === "1";
const distBuilt = (() => {
  try {
    accessSync(`${distDir}/coverage-hooks.mjs`);
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

/** Every specifier the file imports, and every specifier those reach, transitively. */
function reachedSpecifiers(entry: string): Set<string> {
  const seen = new Set<string>();
  const external = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const code = readFileSync(file, "utf8");
    for (const pattern of [IMPORT_FROM, BARE_IMPORT]) {
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

describe.skipIf(!distBuilt)("injected subpaths depend on nothing but node", () => {
  for (const name of INJECTED) {
    test(`ccqa/${name}`, () => {
      const external = [...reachedSpecifiers(`${distDir}/${name}.mjs`)];
      const foreign = external.filter((specifier) => !specifier.startsWith("node:"));
      expect(foreign, `${name} would need these installed in the consumer's test process`).toEqual(
        [],
      );
    });
  }
});
