import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { startBrowserCoverage } from "../../../src/coverage/browser/engine.ts";
import { resolveAgentBrowserBin } from "../../../src/runtime/agent-browser-bin.ts";
import { spawnAB } from "../../../src/runtime/spawn-ab.ts";
import { acquireAgentBrowserEndpoint } from "../../../src/targets/agent-browser/browser-endpoint.ts";

/**
 * The acquisition engine against a real browser — the one thing no fake can
 * answer. agent-browser is this repo's own devDependency and brings its own
 * Chrome, and the endpoint is acquired through the live runner's own
 * `acquireAgentBrowserEndpoint`, so what runs here is the live path.
 *
 * The navigations are driven with an *async* exec, and that is load-bearing:
 * the fixture server lives in this test process, and a synchronous spawn
 * would block the event loop the server answers from — the navigation then
 * waits on a server that waits on the navigation. Production has no such
 * cycle (the application server is its own process), so the test must not
 * invent one.
 *
 * Everything asserted is a real end-to-end fact: the spec cookie arrives at a
 * real HTTP server on the document request, a script served with a source map
 * comes back as its original project path, and a cross-document navigation
 * does not lose the first page's counters.
 *
 * Skipped where no browser can run (CI): the gate is agent-browser's own
 * browser cache, because first use would otherwise download Chrome.
 */

const execFileAsync = promisify(execFile);

const SPEC_ID = "e2etest.coverage-check/browser";
const SESSION = `ccqa-e2e-coverage-${process.pid}`;

function realBrowserAvailable(): boolean {
  try {
    resolveAgentBrowserBin();
  } catch {
    return false;
  }
  return existsSync(join(homedir(), ".agent-browser", "browsers"));
}

const MAP = Buffer.from(
  JSON.stringify({
    version: 3,
    sources: ["webpack://app/./src/app.ts"],
    names: [],
    mappings: "AAAA;AAAA;AAAA",
  }),
).toString("base64");

const APP_JS = [
  "function covered() { return 1; }",
  "covered();",
  `//# sourceMappingURL=data:application/json;charset=utf-8;base64,${MAP}`,
].join("\n");

interface SeenRequest {
  path: string;
  cookie: string | undefined;
}

describe.skipIf(!realBrowserAvailable())("browser coverage engine (real browser)", () => {
  let server: Server;
  let origin: string;
  let coverageDir: string;
  const seen: SeenRequest[] = [];
  const warnings: string[] = [];

  beforeAll(async () => {
    coverageDir = mkdtempSync(join(tmpdir(), "ccqa-e2e-coverage-"));
    server = createServer((req, res) => {
      seen.push({ path: req.url ?? "", cookie: req.headers.cookie });
      if (req.url === "/app.js") {
        res.writeHead(200, { "content-type": "text/javascript" });
        res.end(APP_JS);
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<html><body>${req.url}<script src="/app.js"></script></body></html>`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("no server address");
    origin = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    spawnAB(["--session", SESSION, "close"]);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(coverageDir, { recursive: true, force: true });
  });

  test("attaches the cookie, resolves a mapped script, survives navigation", async () => {
    const browser = await acquireAgentBrowserEndpoint({
      cwd: process.cwd(),
      featureName: "coverage-check",
      specName: "browser",
      driverSession: SESSION,
    });

    const engine = await startBrowserCoverage({
      cdpUrl: browser.cdpUrl,
      specId: SPEC_ID,
      origins: [origin],
      coverageDir,
      roots: { base: coverageDir, root: coverageDir },
      warn: (text) => warnings.push(text),
    });
    try {
      const bin = resolveAgentBrowserBin();
      await execFileAsync(bin, ["--session", SESSION, "open", `${origin}/`], { timeout: 30_000 });
      // A second document: the navigation must not cost the first page its
      // counters, and the fresh document's request must carry the cookie too.
      await execFileAsync(bin, ["--session", SESSION, "open", `${origin}/two`], {
        timeout: 30_000,
      });
    } finally {
      await engine.stop();
    }

    const written = JSON.parse(
      readFileSync(join(coverageDir, "coverage-frontend.json"), "utf8"),
    ) as { specId: string; files: string[]; stopped: boolean };
    expect(written.specId).toBe(SPEC_ID);
    // The script executed on page one, before the navigation to page two —
    // present only if the pre-navigation take really happened.
    expect(written.files).toContain("src/app.ts");
    expect(written.stopped).toBe(false);

    const documents = seen.filter((r) => r.path === "/" || r.path === "/two");
    expect(documents.length).toBeGreaterThanOrEqual(2);
    for (const doc of documents) {
      expect(doc.cookie ?? "").toContain(`__ccqa_coverage=${SPEC_ID}`);
    }
    expect(warnings, warnings.join("; ")).toEqual([]);
  });
});
