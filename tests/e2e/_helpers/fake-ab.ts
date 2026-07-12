import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Writes a fake `agent-browser` npm package into a target directory so that
// ccqa/test-helpers' `createRequire().resolve("agent-browser/...")` locates
// this stub instead of the real browser driver.
//
// The stub logs its argv (JSON-serialized, one line per invocation) to the
// path in $CCQA_FAKE_AB_LOG and exits with $CCQA_FAKE_AB_EXIT (default 0).
//
// If `targetDir` is provided, the package is materialized there directly
// (used by install-smoke, which then installs it via `file:` so pnpm peer-
// links it into ccqa's isolated store). Otherwise it's written into
// <projectCwd>/node_modules/agent-browser, which is what the in-tree fixture
// flow uses (no real install, just drop the package next to ccqa).
export async function installFakeAgentBrowser(
  projectCwd: string,
  targetDir?: string,
): Promise<void> {
  const pkgDir = targetDir ?? join(projectCwd, "node_modules", "agent-browser");
  const binDir = join(pkgDir, "bin");
  await mkdir(binDir, { recursive: true });

  const pkgJson = {
    name: "agent-browser",
    version: "0.0.0-fake",
    type: "module",
    bin: { "agent-browser": "./bin/agent-browser.js" },
  };
  await writeFile(
    join(pkgDir, "package.json"),
    JSON.stringify(pkgJson, null, 2),
    "utf8",
  );

  const binScript = `#!/usr/bin/env node
import { appendFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
const argv = process.argv.slice(2);
const logPath = process.env.CCQA_FAKE_AB_LOG;
if (logPath) {
  try {
    appendFileSync(logPath, JSON.stringify(argv) + "\\n");
  } catch {}
}
// Live mode takes per-step PNG screenshots via \`agent-browser ... screenshot <path>\`.
// In the e2e harness the real Chrome isn't available, so write a 1x1 PNG to the
// requested path so the executor sees \`before.ok / after.ok\` true and the
// renderer can link to a file that actually exists.
const screenshotIdx = argv.indexOf("screenshot");
if (screenshotIdx !== -1) {
  const outPath = argv[screenshotIdx + 1];
  if (outPath) {
    try {
      mkdirSync(dirname(outPath), { recursive: true });
      // Minimal valid 1x1 transparent PNG.
      writeFileSync(outPath, Buffer.from([
        0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0x00,0x00,0x00,0x0d,0x49,0x48,0x44,0x52,
        0x00,0x00,0x00,0x01,0x00,0x00,0x00,0x01,0x08,0x06,0x00,0x00,0x00,0x1f,0x15,0xc4,
        0x89,0x00,0x00,0x00,0x0d,0x49,0x44,0x41,0x54,0x78,0x9c,0x62,0x00,0x01,0x00,0x00,
        0x05,0x00,0x01,0x0d,0x0a,0x2d,0xb4,0x00,0x00,0x00,0x00,0x49,0x45,0x4e,0x44,0xae,
        0x42,0x60,0x82,
      ]));
    } catch {}
  }
}
const exitStr = process.env.CCQA_FAKE_AB_EXIT ?? "0";
// \`get count <selector>\` must print a number (assert/wait helpers parse it);
// CCQA_FAKE_AB_COUNT overrides the generic stdout for those invocations so a
// single fake can serve both \`get url\` (CCQA_FAKE_AB_STDOUT) and \`get count\`.
const getIdx = argv.indexOf("get");
const countLine =
  getIdx !== -1 && argv[getIdx + 1] === "count" ? process.env.CCQA_FAKE_AB_COUNT : undefined;
const stdoutLine = countLine ?? process.env.CCQA_FAKE_AB_STDOUT;
if (stdoutLine) process.stdout.write(stdoutLine + "\\n");
process.exit(Number(exitStr));
`;
  const binPath = join(binDir, "agent-browser.js");
  await writeFile(binPath, binScript, "utf8");
  await chmod(binPath, 0o755);
}
