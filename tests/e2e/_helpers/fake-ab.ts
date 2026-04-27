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
import { appendFileSync } from "node:fs";
const logPath = process.env.CCQA_FAKE_AB_LOG;
if (logPath) {
  try {
    appendFileSync(logPath, JSON.stringify(process.argv.slice(2)) + "\\n");
  } catch {}
}
const exitStr = process.env.CCQA_FAKE_AB_EXIT ?? "0";
const stdoutLine = process.env.CCQA_FAKE_AB_STDOUT;
if (stdoutLine) process.stdout.write(stdoutLine + "\\n");
process.exit(Number(exitStr));
`;
  const binPath = join(binDir, "agent-browser.js");
  await writeFile(binPath, binScript, "utf8");
  await chmod(binPath, 0o755);
}
