import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "tsdown";

// ccqa has two public surfaces:
//   1. the `ccqa` CLI binary (bin/ccqa.ts)   → dist/bin/ccqa.mjs
//   2. the `ccqa/test-helpers` subpath export → dist/runtime/test-helpers.mjs + .d.mts
// plus the vitest config used at runtime by `ccqa run --config <this>`
// emitted as dist/runtime/vitest.config.mjs (not bundled in).
//
// We keep the default `.mjs` extension rather than renaming to `.js`:
// - Explicit ESM marker independent of any package.json "type" field
// - Avoids the tsdown shebang/banner double-emit that happens with .js
// - Matches how most modern Node CLIs (biome, tsdown itself, ...) ship
export default defineConfig({
  entry: {
    "bin/ccqa": "./bin/ccqa.ts",
    "runtime/test-helpers": "./src/runtime/test-helpers.ts",
    "runtime/vitest.config": "./src/runtime/vitest.config.ts",
  },
  format: "esm",
  platform: "node",
  target: "node20",
  dts: true,
  clean: true,
  outDir: "dist",
  // Everything runtime (peer + real deps) stays external. The CLI binary
  // imports these at runtime from the consumer's node_modules.
  external: [
    "commander",
    "gray-matter",
    "zod",
    "@anthropic-ai/claude-agent-sdk",
    "@anthropic-ai/claude-code",
    "vitest",
    "vitest/config",
    "agent-browser",
  ],
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
});
