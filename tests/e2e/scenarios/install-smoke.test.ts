import { spawnSync } from "node:child_process";
import { accessSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { getRepoRoot } from "../_helpers/cli.ts";
import { installFakeAgentBrowser } from "../_helpers/fake-ab.ts";

// End-to-end install smoke: build → pack → pnpm install the tarball into a
// fresh project → run ./node_modules/.bin/ccqa. This is the only scenario
// that exercises the exact code path a real consumer hits, since everything
// else in the suite targets source via CCQA_CLI or a symlink into the repo.
//
// Skipped when dist/ or pnpm is missing, so contributors who never built
// the package locally still see a green suite.
const repoRoot = getRepoRoot();
const distBin = join(repoRoot, "dist/bin/ccqa.mjs");

const distBuilt = (() => {
  try {
    accessSync(distBin);
    return true;
  } catch {
    return false;
  }
})();

const pnpmAvailable = spawnSync("pnpm", ["--version"]).status === 0;

describe.skipIf(!distBuilt || !pnpmAvailable)(
  "ccqa — install smoke (packed tarball)",
  () => {
    let tarball: string | null = null;
    let consumer: string | null = null;

    beforeAll(async () => {
      // pack the repo into a tarball inside a dedicated directory so we can
      // find its exact filename without parsing pnpm pack output.
      const packDir = await mkdtemp(join(tmpdir(), "ccqa-smoke-pack-"));
      const pack = spawnSync(
        "pnpm",
        ["pack", "--pack-destination", packDir],
        { cwd: repoRoot, encoding: "utf8" },
      );
      if (pack.status !== 0) {
        throw new Error(`pnpm pack failed: ${pack.stderr}`);
      }
      const tgz = readdirSync(packDir).find((f) => f.endsWith(".tgz"));
      if (!tgz) throw new Error(`no tarball produced in ${packDir}`);
      tarball = join(packDir, tgz);

      consumer = await mkdtemp(join(tmpdir(), "ccqa-smoke-consumer-"));

      // Materialize a fake agent-browser package next to consumer/ so we can
      // install it as a real top-level dep. This is what pnpm will then peer-
      // link into ccqa's isolated node_modules — without this step pnpm pulls
      // the real agent-browser from the registry to satisfy the peer.
      const fakeAbDir = join(consumer, "fake-agent-browser");
      await installFakeAgentBrowser(consumer, fakeAbDir);

      writeFileSync(
        join(consumer, "package.json"),
        JSON.stringify(
          {
            name: "ccqa-smoke-consumer",
            version: "0.0.0",
            type: "module",
            dependencies: { "agent-browser": `file:${fakeAbDir}` },
          },
          null,
          2,
        ),
        "utf8",
      );
      const add = spawnSync(
        "pnpm",
        [
          "add",
          "--save-dev",
          `file:${tarball}`,
          "vitest@^4",
        ],
        { cwd: consumer, encoding: "utf8", env: { ...process.env } },
      );
      if (add.status !== 0) {
        throw new Error(`pnpm add failed: ${add.stderr}`);
      }
    }, 180_000);

    afterAll(async () => {
      if (consumer) await rm(consumer, { recursive: true, force: true });
      if (tarball) await rm(resolve(tarball, ".."), { recursive: true, force: true });
    });

    test("installed CLI runs a spec end-to-end", async () => {
      if (!consumer) throw new Error("consumer not initialized");
      // Drop a minimal spec that exercises ccqa/test-helpers (and thus
      // fake agent-browser resolution via createRequire).
      const specDir = join(consumer, ".ccqa/features/demo/test-cases/smoke");
      spawnSync("mkdir", ["-p", specDir]);
      writeFileSync(
        join(specDir, "test.spec.ts"),
        `import { test } from "vitest";\n` +
          `import { ab } from "ccqa/test-helpers";\n` +
          `test("installed smoke", () => { ab("open", "about:blank"); });\n`,
        "utf8",
      );

      const logPath = join(consumer, "ab.log");
      const ccqaBin = join(consumer, "node_modules/.bin/ccqa");
      const result = spawnSync(ccqaBin, ["run", "demo/smoke"], {
        cwd: consumer,
        encoding: "utf8",
        env: {
          ...process.env,
          NO_COLOR: "1",
          FORCE_COLOR: "0",
          CCQA_FAKE_AB_LOG: logPath,
        },
      });

      const combined = (result.stdout ?? "") + (result.stderr ?? "");
      expect(result.status, combined).toBe(0);
      expect(combined).toMatch(/1\/1\s+passed/);
    }, 120_000);
  },
);
