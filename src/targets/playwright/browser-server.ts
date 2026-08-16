import { existsSync } from "node:fs";
import { readdir, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { CdpBrowserHandle, CdpEndpointContext } from "../types.ts";

/**
 * Where the playwright target's browser comes from under `--coverage`.
 *
 * `playwright test` launches its own browser inside a process ccqa does not
 * own, and Playwright has no environment knob that would open a debugging
 * port on it. So the ownership is inverted: ccqa launches a browser server —
 * with the *consumer's own* Playwright, so the wire protocol matches by
 * construction — and a generated config makes the tests connect to it via
 * `use.connectOptions`. The config wrapper imports the project's real config,
 * so everything else about the run is the project's own; it is written next
 * to that config because Playwright resolves relative paths against the
 * config's directory, and a wrapper anywhere else would silently re-root
 * them.
 *
 * The ordering this buys is the point: the browser exists and the engine is
 * attached before the test process is even spawned, so there is no window in
 * which a script can run unprofiled or a request can leave uncookied.
 */

const CONNECT_ENV = "CCQA_PW_CONNECT";

const CONFIG_NAMES = [
  "playwright.config.ts",
  "playwright.config.mts",
  "playwright.config.cts",
  "playwright.config.js",
  "playwright.config.mjs",
  "playwright.config.cjs",
];

interface PlaywrightBrowserServer {
  wsEndpoint(): string;
  close(): Promise<void>;
}

interface PlaywrightChromium {
  launchServer(options: { args: string[] }): Promise<PlaywrightBrowserServer>;
}

export async function acquirePlaywrightBrowser(
  ctx: CdpEndpointContext,
): Promise<CdpBrowserHandle> {
  await sweepStaleWrappers(ctx.cwd);
  const chromium = await resolveChromium(ctx.cwd);
  const port = await freePort();
  const server = await chromium.launchServer({ args: [`--remote-debugging-port=${port}`] });
  let wrapperPath: string | undefined;
  try {
    await waitForCdp(port);
    wrapperPath = await writeWrapperConfig(ctx);
  } catch (error) {
    await server.close().catch(() => undefined);
    throw error;
  }
  const wrapper = wrapperPath;
  // Idempotent, because it runs from two places: the runner's `finally` on the
  // ordinary path, and the run's signal teardown when Ctrl-C bypasses it —
  // node skips `finally` blocks on an unhandled signal, and the alternative is
  // a stray config file at the consumer's repo root plus an orphaned browser.
  let disposed = false;
  return {
    cdpUrl: `http://127.0.0.1:${port}`,
    env: { [CONNECT_ENV]: server.wsEndpoint() },
    amendCommand: (command) => {
      if (/(^|\s)(--config|-c)[=\s]/.test(command)) {
        throw new Error(
          "the runCommand already passes --config; --coverage needs to supply its own. " +
            "Drop the flag from targets.playwright.runCommand (the default config resolution " +
            "still applies) or run without --coverage.",
        );
      }
      // The command runs through a shell; anything that would hand the flag to
      // a different program (a pipe, a chained command) is refused rather than
      // silently misattached.
      if (/[|;&<>`$]/.test(command)) {
        throw new Error(
          "the runCommand uses shell operators, so --coverage cannot safely append its " +
            "--config to it. Reduce targets.playwright.runCommand to a plain `playwright test` " +
            "invocation or run without --coverage.",
        );
      }
      return `${command} --config=${shellQuote(wrapper)}`;
    },
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      await server.close().catch(() => undefined);
      await unlink(wrapper).catch(() => undefined);
    },
  };
}

/**
 * Wrappers a killed earlier run left behind. Deleted on the next acquire, not
 * only guarded against: a stray one is git-status dirt in somebody's repo.
 */
async function sweepStaleWrappers(cwd: string): Promise<void> {
  const entries = await readdir(cwd).catch(() => []);
  for (const name of entries) {
    if (name.startsWith("ccqa-coverage.") && name.endsWith(".playwright.config.ts")) {
      await unlink(join(cwd, name)).catch(() => undefined);
    }
  }
}

/** Single quotes survive every shell metacharacter except themselves. */
function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/**
 * The consumer's Playwright, not a dependency of ccqa's: their tests speak
 * their version's protocol, and the server has to be the same animal. Their
 * `runCommand` runs `playwright test`, so the package is present — but under
 * pnpm's isolation it may only be resolvable through `@playwright/test`.
 */
async function resolveChromium(cwd: string): Promise<PlaywrightChromium> {
  const fromProject = createRequire(join(cwd, "package.json"));
  const origins: string[] = [];
  try {
    origins.push(fromProject.resolve("@playwright/test/package.json"));
  } catch {
    // Fine — the direct names below may still resolve.
  }
  for (const name of ["playwright", "playwright-core"]) {
    for (const origin of [null, ...origins]) {
      try {
        const req = origin === null ? fromProject : createRequire(origin);
        const modPath = req.resolve(name);
        const mod = (await import(pathToFileURL(modPath).href)) as {
          chromium?: PlaywrightChromium;
          default?: { chromium?: PlaywrightChromium };
        };
        const chromium = mod.chromium ?? mod.default?.chromium;
        if (chromium !== undefined) return chromium;
      } catch {
        // Try the next resolution origin.
      }
    }
  }
  throw new Error(
    `could not resolve Playwright from ${cwd} — the playwright target's --coverage launches ` +
      "the browser with the project's own Playwright, which must be installed",
  );
}

async function writeWrapperConfig(ctx: CdpEndpointContext): Promise<string> {
  const existing = CONFIG_NAMES.find((name) => existsSync(join(ctx.cwd, name)));
  const wrapperName = `ccqa-coverage.${slug(ctx.featureName)}--${slug(ctx.specName)}.playwright.config.ts`;
  const wrapperPath = join(ctx.cwd, wrapperName);
  const header = "// Written by `ccqa run --coverage` for one spec's run and removed after it.";
  const connect = `use: { ...(base as { use?: object }).use, connectOptions: { wsEndpoint: process.env.${CONNECT_ENV} ?? "" } }`;
  const body =
    existing === undefined
      ? [
          header,
          `export default { use: { connectOptions: { wsEndpoint: process.env.${CONNECT_ENV} ?? "" } } };`,
          "",
        ]
      : [
          header,
          "// It only points the browser at the server ccqa launched; everything else",
          "// is the project's own config, imported unchanged.",
          `import base from "./${existing}";`,
          `export default { ...(base as object), ${connect} };`,
          "",
        ];
  await writeFile(wrapperPath, body.join("\n"), "utf8");
  return wrapperPath;
}

function slug(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "-");
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : undefined;
      probe.close(() => {
        if (port === undefined) reject(new Error("could not pick a port"));
        else resolve(port);
      });
    });
  });
}

/** The debugging socket opens with the browser; a short poll absorbs the gap. */
async function waitForCdp(port: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return;
    } catch {
      // Not up yet.
    }
    if (Date.now() > deadline) {
      throw new Error(`the launched browser never opened its debugging port (${port})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
