import { defineConfig } from "tsdown";

// Each entry is built on its own so no two share a chunk.
//
// A shared chunk here is not an optimisation, it is a correctness problem: with
// one build, the bundler put a `require("./register.cjs")` — the Node-only half
// — inside the Temporal workflow entry because both reach `wire.ts`, and the
// workflow sandbox then failed to resolve `node:http`. The modules are small
// enough that duplicating them costs nothing, and the process-wide state lives
// on `globalThis` precisely so duplicated copies still agree.
//
// Both formats are emitted for every entry. A Next.js server bundle is CJS and
// `require()`s what it does not bundle; a Temporal workflow bundle is CJS too;
// a `--import` preload can be either. Shipping one format would strand one.
// Keys are the built paths under dist/, one directory per feature. This package
// installs into the application under test, so a feature that lands here has to
// stay near-dependency-free — otherwise every consumer of one feature carries
// the others'. A file absent from this list, like `coverage/temporal/header.ts`,
// is package-private by that fact.
const ENTRIES = {
  "coverage/core": "./src/coverage/core.ts",
  "coverage/register": "./src/coverage/register.ts",
  "coverage/middleware": "./src/coverage/middleware.ts",
  "coverage/slack": "./src/coverage/presets/slack.ts",
  "coverage/collector": "./src/coverage/collector.ts",
  "coverage/next": "./src/coverage/next/index.ts",
  "coverage/next-loader": "./src/coverage/next/loader.ts",
  "coverage/temporal": "./src/coverage/temporal/index.ts",
  "coverage/temporal-workflow": "./src/coverage/temporal/workflow.ts",
};

export default Object.entries(ENTRIES).map(([name, entry], index) =>
  defineConfig({
    entry: { [name]: entry },
    format: ["esm", "cjs"],
    platform: "neutral",
    target: "node20",
    dts: true,
    // Only the first build may clean, or it deletes its siblings' output.
    clean: index === 0,
    outDir: "dist",
    external: [/^node:/, "acorn", /^@temporalio\//],
  }),
);
