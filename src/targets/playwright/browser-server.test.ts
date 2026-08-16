import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The pure halves of the playwright browser acquisition: the wrapper config's
 * shape and the runCommand amendment. The launchServer half needs a real
 * Playwright and is exercised against a consuming project, not here.
 */

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function acquireInto(cwd: string) {
  const { acquirePlaywrightBrowser } = await import("./browser-server.ts");
  return acquirePlaywrightBrowser({ cwd, featureName: "feature", specName: "spec" });
}

function fakePlaywright(cwd: string): void {
  // A resolvable "playwright" whose launchServer needs no browser.
  const dir = join(cwd, "node_modules", "playwright");
  writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "consumer" }));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "playwright", main: "./index.js" }));
  writeFileSync(
    join(dir, "index.js"),
    [
      "const http = require('node:http');",
      "exports.chromium = { launchServer: async ({ args }) => {",
      "  const port = Number(args[0].split('=')[1]);",
      "  const server = http.createServer((req, res) => {",
      "    res.setHeader('content-type', 'application/json');",
      "    res.end(JSON.stringify({ webSocketDebuggerUrl: 'ws://127.0.0.1:' + port + '/devtools/browser/x' }));",
      "  });",
      "  await new Promise((r) => server.listen(port, '127.0.0.1', r));",
      "  return { wsEndpoint: () => 'ws://127.0.0.1:' + port + '/pw', close: () => new Promise((r) => server.close(r)) };",
      "} };",
    ].join("\n"),
  );
}

describe("acquirePlaywrightBrowser", () => {
  it("writes a wrapper that extends the project's config, next to it", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "ccqa-pw-"));
    dirs.push(cwd);
    fakePlaywright(cwd);
    writeFileSync(join(cwd, "playwright.config.ts"), "export default { use: {} };\n");
    const handle = await acquireInto(cwd);
    try {
      const amended = handle.amendCommand!("pnpm exec playwright test {files}");
      const wrapperPath = /--config='([^']+)'/.exec(amended)?.[1];
      expect(wrapperPath).toBeDefined();
      const wrapper = readFileSync(wrapperPath!, "utf8");
      // Extends the real config rather than replacing it — relative paths in
      // that config only survive if the wrapper sits in the same directory.
      expect(wrapper).toContain(`import base from "./playwright.config.ts"`);
      expect(wrapper).toContain("connectOptions");
      expect(wrapperPath).toContain(cwd);
      expect(handle.env).toHaveProperty("CCQA_PW_CONNECT");
      expect(handle.cdpUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    } finally {
      await handle.dispose();
    }
  });

  it("refuses a runCommand that already pins --config", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "ccqa-pw-"));
    dirs.push(cwd);
    fakePlaywright(cwd);
    const handle = await acquireInto(cwd);
    try {
      expect(() => handle.amendCommand!("playwright test --config=mine.ts {files}")).toThrow(
        /--config/,
      );
    } finally {
      await handle.dispose();
    }
  });

  it("says what is missing when the project has no Playwright", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "ccqa-pw-"));
    dirs.push(cwd);
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "consumer" }));
    await expect(acquireInto(cwd)).rejects.toThrow(/could not resolve Playwright/);
  });
});
