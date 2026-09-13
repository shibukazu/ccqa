import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "tsdown";

// ccqa has two public surfaces:
//   1. the `ccqa` CLI binary (bin/ccqa.ts)   → dist/bin/ccqa.mjs
//   2. the `ccqa/test-helpers` subpath export → dist/runtime/test-helpers.mjs + .d.mts
//      and its sibling `ccqa/step-evidence`, which generated tests for
//      external targets import for step-boundary screenshots
// plus the vitest config used at runtime by `ccqa run --config <this>`
// emitted as dist/runtime/vitest.config.mjs (not bundled in).
//
// We keep the default `.mjs` extension rather than renaming to `.js`:
// - Explicit ESM marker independent of any package.json "type" field
// - Avoids the tsdown shebang/banner double-emit that happens with .js
// - Matches how most modern Node CLIs (biome, tsdown itself, ...) ship
/**
 * The subpaths a consumer's own test file imports. Emitted as CJS as well as
 * ESM, because most Playwright suites are CommonJS: without a `require`
 * condition the import fails at resolution, the run reports that it found no
 * tests, and the generation's fix pass helpfully deletes the import — taking
 * the step screenshots with it. Node 22 can `require()` an ESM file, but only
 * experimentally and with a warning on every run, which is not a contract to
 * ship on.
 */
const CONSUMER_ENTRY = {
  "runtime/test-helpers": "./src/runtime/test-helpers.ts",
  "runtime/step-evidence": "./src/runtime/step-evidence.ts",
  "runtime/judge": "./src/runtime/judge.ts",
  "hub-client/index": "./src/hub-client/index.ts",
};

// Everything runtime (peer + real deps) stays external. The CLI binary
// imports these at runtime from the consumer's node_modules.
const EXTERNAL = [
  "commander",
  "gray-matter",
  "zod",
  "@anthropic-ai/claude-agent-sdk",
  "vitest",
  "vitest/config",
  "agent-browser",
];

const SHARED = {
  platform: "node",
  target: "node20",
  dts: true,
  outDir: "dist",
  external: EXTERNAL,
} as const;

export default [
  defineConfig({
    ...SHARED,
    entry: CONSUMER_ENTRY,
    format: ["esm", "cjs"],
    // Only the first build may clean, or it deletes its sibling's output.
    clean: true,
  }),
  defineConfig({
  ...SHARED,
  entry: {
    "bin/ccqa": "./bin/ccqa.ts",
    "runtime/vitest.config": "./src/runtime/vitest.config.ts",
  },
  format: "esm",
  clean: false,
  // tsdown injects #!/usr/bin/env node into .mjs outputs that come from
  // source files starting with a shebang. Our bin/ccqa.ts already has one,
  // so no banner option is needed here.
  hooks: {
    "build:done": () => {
      // Copy a trimmed package.json into dist/ so:
      //   - CLI's version lookup (readFileSync(new URL("../package.json", import.meta.url)))
      //     resolves correctly from dist/cli/index.mjs
      //   - downstream tooling sees a valid manifest inside dist/
      const root = process.cwd();
      const pkg = JSON.parse(
        readFileSync(resolve(root, "package.json"), "utf8"),
      ) as Record<string, unknown>;
      delete pkg.devDependencies;
      delete pkg.scripts;
      delete pkg.packageManager;
      delete pkg.devEngines;
      writeFileSync(
        resolve(root, "dist/package.json"),
        JSON.stringify(pkg, null, 2) + "\n",
        "utf8",
      );
      chmodSync(resolve(root, "dist/bin/ccqa.mjs"), 0o755);
    },
  },
  }),
];
