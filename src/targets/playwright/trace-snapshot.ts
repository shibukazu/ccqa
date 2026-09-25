import { createReadStream, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, resolve, sep } from "node:path";

import type { SnapshotRef } from "./trace-evidence.ts";
import { loadPlaywright } from "./resolve-playwright.ts";

/**
 * Renders a trace's DOM snapshots the way Playwright's trace viewer shows them,
 * assertion-target highlight included.
 *
 * It drives the viewer of the project's own Playwright, so the viewer always
 * matches the version that wrote the trace. None of what it relies on is public
 * API (checked present from Playwright 1.48, verified end to end on 1.62):
 * - `playwright-core/lib/vite/traceViewer/` (outside the package's exports),
 *   served as static files
 * - the viewer's service worker routes `contexts?trace=<url>` (loads the trace)
 *   and `snapshot/<pageId>?trace=<url>&name=<snapshotName>` (one snapshot; the
 *   pageId must not be percent-encoded), opened through
 *   `snapshot.html?r=<snapshot url>`
 * A Playwright release that moves any of these costs the report its pictures,
 * never the run.
 */

export interface SnapshotRenderer {
  /** One snapshot as a JPEG, or null when it renders as an empty page. */
  render(snapshot: SnapshotRef): Promise<Buffer | null>;
  close(): Promise<void>;
}

// The slice of Playwright's API used here, so ccqa needs no Playwright types.
interface Frame {
  waitForURL(url: RegExp, options: { waitUntil: "load" }): Promise<void>;
  waitForFunction(expression: string): Promise<unknown>;
  evaluate(expression: string): Promise<unknown>;
}
interface Page {
  setDefaultTimeout(ms: number): void;
  setViewportSize(size: { width: number; height: number }): Promise<void>;
  goto(url: string): Promise<unknown>;
  waitForFunction(expression: string): Promise<unknown>;
  evaluate(expression: string): Promise<unknown>;
  waitForSelector(selector: string): Promise<{ contentFrame(): Promise<Frame | null> }>;
  screenshot(options: { type: "jpeg" }): Promise<Buffer>;
}
interface Browser {
  newPage(): Promise<Page>;
  close(): Promise<void>;
}
interface Chromium {
  launch(options: { timeout: number }): Promise<Browser>;
}

/** A snapshot that never settles must not hold the run's report hostage. */
const RENDER_TIMEOUT_MS = 15_000;
const LAUNCH_TIMEOUT_MS = 30_000;

const TRACE_PATH = "trace.zip";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".zip": "application/zip",
};

/**
 * A renderer over one trace archive, using the first Playwright `dirs`
 * resolves. Throws when that Playwright, its viewer, or its Chromium is missing.
 */
export async function openSnapshotRenderer(
  dirs: readonly string[],
  archive: string,
): Promise<SnapshotRenderer> {
  const { coreDir, chromium } = await loadPlaywright<Chromium>(dirs);
  const viewerDir = join(coreDir, "lib", "vite", "traceViewer");
  if (!isFile(join(viewerDir, "snapshot.html"))) {
    throw new Error(`the installed Playwright has no trace viewer at ${viewerDir}`);
  }

  const server = await serve(viewerDir, archive);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  const browser = await chromium.launch({ timeout: LAUNCH_TIMEOUT_MS }).catch(async (err) => {
    await closeServer(server);
    throw err;
  });
  const close = async () => {
    try {
      await browser.close();
    } finally {
      await closeServer(server);
    }
  };
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(RENDER_TIMEOUT_MS);
    await page.goto(`${base}snapshot.html?trace=${TRACE_PATH}`);
    await page.waitForFunction("!!navigator.serviceWorker.controller");
    const loaded = await page.evaluate(`fetch("contexts?trace=${TRACE_PATH}").then((r) => r.ok)`);
    if (loaded !== true) throw new Error("the trace viewer could not load the trace");

    return {
      async render(snapshot) {
        if (snapshot.viewport) await page.setViewportSize(snapshot.viewport);
        // Canvas pixels are not in the DOM. The viewer can paint them from the nearest
        // recorded frame (`shouldPopulateCanvasFromScreenshot`), but that frame may be
        // from another moment, so the placeholder it draws otherwise is kept.
        const url =
          `${base}snapshot/${snapshot.pageId}?trace=${TRACE_PATH}` +
          `&name=${encodeURIComponent(snapshot.name)}`;
        await page.goto(`${base}snapshot.html?trace=${TRACE_PATH}&r=${encodeURIComponent(url)}`);
        const frame = await (await page.waitForSelector("iframe")).contentFrame();
        if (frame === null) throw new Error("the trace viewer showed no snapshot frame");
        await frame.waitForURL(/\/snapshot\//, { waitUntil: "load" });
        // The snapshot's fonts and images come through the service worker after `load`.
        await frame.waitForFunction(
          "document.fonts.status === 'loaded' && Array.from(document.images).every((i) => i.complete)",
        );
        // Both a page not yet navigated and a snapshot the viewer cannot find load as an empty document.
        const blank = await frame.evaluate(
          "!document.body || (document.body.childElementCount === 0 && document.body.textContent.trim() === '')",
        );
        return blank === false ? page.screenshot({ type: "jpeg" }) : null;
      },
      close,
    };
  } catch (err) {
    await close().catch(() => {});
    throw err;
  }
}

/** The viewer's files and the one archive, on loopback only. */
async function serve(viewerDir: string, archive: string): Promise<Server> {
  const root = resolve(viewerDir);
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    const file = path === `/${TRACE_PATH}` ? archive : resolve(root, `.${path}`);
    if ((file !== archive && !file.startsWith(root + sep)) || !isFile(file)) {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.setHeader("Content-Type", CONTENT_TYPES[extname(file)] ?? "application/octet-stream");
    createReadStream(file)
      .on("error", () => res.destroy())
      .pipe(res);
  });
  await new Promise<void>((done, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", done);
  });
  return server;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((done) => server.close(() => done()));
}
