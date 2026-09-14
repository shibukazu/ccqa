import { execFile } from "node:child_process";
import { accessSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import { getRepoRoot } from "../_helpers/cli.ts";

const run = promisify(execFile);

/**
 * The subpaths a consumer's own test file imports have to resolve from
 * CommonJS. Most Playwright suites are CommonJS — no `type: "module"` — and
 * without a `require` condition the import fails at resolution time, the run
 * reports that it found no tests, and the generation's fix pass removes the
 * import to make the failure go away. The spec then runs with no step
 * evidence at all, which is exactly the shape that is hard to notice.
 *
 * Skipped when dist/ is not built, like the shebang contract test; set
 * CCQA_REQUIRE_DIST=1 in CI so a missing build fails here instead.
 */
const repoRoot = getRepoRoot();
const distBuilt = (() => {
  try {
    accessSync(join(repoRoot, "dist/runtime/step-evidence.cjs"));
    return true;
  } catch {
    return false;
  }
})();

if (process.env.CCQA_REQUIRE_DIST === "1" && !distBuilt) {
  throw new Error("CCQA_REQUIRE_DIST=1 but dist/ has no CJS build — run `pnpm build`");
}

describe.skipIf(process.platform === "win32" || !distBuilt)("ccqa subpaths under CommonJS", () => {
  let dir: string | null = null;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  test.each([
    ["ccqa/step-evidence", ["ccqaStepAfter", "ccqaStepBefore"]],
    ["ccqa/test-helpers", []],
  ])("require(%s) resolves and exports what a generated test calls", async (subpath, expected) => {
    dir = mkdtempSync(join(tmpdir(), "ccqa-cjs-"));
    mkdirSync(join(dir, "node_modules"), { recursive: true });
    symlinkSync(repoRoot, join(dir, "node_modules/ccqa"), "dir");
    // No `type` field: the default, and the shape this exists to cover.
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "consumer" }), "utf8");
    writeFileSync(
      join(dir, "probe.cjs"),
      `const m = require(${JSON.stringify(subpath)});\nconsole.log(Object.keys(m).sort().join(","));\n`,
      "utf8",
    );

    const { stdout } = await run(process.execPath, [join(dir, "probe.cjs")], { cwd: dir });
    for (const name of expected) expect(stdout).toContain(name);
  }, 60_000);
});
