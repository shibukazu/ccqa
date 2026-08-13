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
// Keys are the built filenames, so they stay as they are while the sources move
// to mirror the subpaths they serve. A file inside one of those directories and
// absent from this list — `temporal/header.ts` — is package-private by that fact.
const ENTRIES = {
  core: "./src/core.ts",
  register: "./src/register.ts",
  middleware: "./src/middleware.ts",
  slack: "./src/presets/slack.ts",
  collector: "./src/collector.ts",
  next: "./src/next/index.ts",
  "next-loader": "./src/next/loader.ts",
  temporal: "./src/temporal/index.ts",
  "temporal-workflow": "./src/temporal/workflow.ts",
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
