import { Command } from "commander";
import { createHubServer } from "../hub/api/server.ts";
import { createHubStorage } from "../hub/core/storage/factory.ts";
import { parseEncryptionKey } from "../hub/core/crypto.ts";
import { driftAuthAvailable } from "../drift/auth.ts";
import { resolveCwd } from "./resolve-cwd.ts";
import * as log from "./logger.ts";

export interface ServeOptions {
  port: string;
  dataDir: string;
  allowOrigin?: string[];
  maxPushMb?: number;
}

export const serveCommand = new Command("serve")
  .description(
    "Start the ccqa hub: a small control-plane HTTP server that aggregates CI run " +
      "results, sessions, variables, and triage records. It does not execute tests — " +
      "CI/local `ccqa run` produces reports and `ccqa hub push` uploads them here. Any " +
      "HTTP client (docs/hub-api.md) can talk to it.",
  )
  .option("--port <n>", "TCP port to listen on.", "8787")
  .option("--data-dir <path>", "Directory to store runs, sessions, and variables in.", "./ccqa-hub-data")
  .option(
    "--allow-origin <origin>",
    "CORS-allowed origin for browser clients (repeatable). Omit for no cross-origin access.",
    (val: string, prev: string[]) => [...prev, val],
    [] as string[],
  )
  .option("--max-push-mb <n>", "Reject pushed report bundles larger than this (MB). Default 32.", parsePositiveInt)
  .action(async (opts: ServeOptions) => {
    await runServe(opts);
  });

function parsePositiveInt(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    log.error(`expected a positive integer, got "${raw}"`);
    process.exit(2);
  }
  return n;
}

async function runServe(opts: ServeOptions): Promise<void> {
  const token = process.env.CCQA_HUB_TOKEN;
  if (!token) {
    log.error("CCQA_HUB_TOKEN is required (the hub's bearer token — pick any non-guessable secret)");
    process.exit(2);
  }

  const encryptionKeyHex = process.env.CCQA_HUB_ENCRYPTION_KEY;
  let encryptionKey: Buffer | null = null;
  if (encryptionKeyHex) {
    try {
      encryptionKey = parseEncryptionKey(encryptionKeyHex);
    } catch (err) {
      log.error(err instanceof Error ? err.message : String(err));
      process.exit(2);
    }
  } else {
    log.warn("CCQA_HUB_ENCRYPTION_KEY is not set — sessions and variables cannot be stored (PUT returns 503)");
  }

  const dataDir = resolveCwd(opts.dataDir);
  const storage = createHubStorage({ driver: "file", dataDir });

  const server = createHubServer({
    storage,
    token,
    encryptionKey,
    allowedOrigins: opts.allowOrigin ?? [],
    ...(opts.maxPushMb ? { maxPushBytes: opts.maxPushMb * 1024 * 1024 } : {}),
  });

  const requestedPort = Number(opts.port);
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) {
    log.error(`invalid --port "${opts.port}" (expected an integer 0-65535)`);
    process.exit(2);
  }
  // Without this, a bind failure (port already in use) surfaces as an
  // unhandled 'error' event with a raw stack trace.
  server.on("error", (err) => {
    log.error(`hub failed to start: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
  server.listen(requestedPort, () => {
    // `--port 0` asks the OS for an ephemeral port (used by tests to avoid
    // fixed-port collisions) — report the port actually bound, not the "0"
    // that was requested.
    const address = server.address();
    const boundPort = address !== null && typeof address !== "string" ? address.port : requestedPort;
    log.header("serve", `port ${boundPort}`);
    log.meta("data-dir", dataDir);
    log.meta("encryption", encryptionKey ? "enabled" : "disabled (no CCQA_HUB_ENCRYPTION_KEY)");
    // Learning jobs always call Claude. Missing auth doesn't stop the hub —
    // only running a learning job fails, at run time.
    const auth = driftAuthAvailable();
    log.meta("triage learning", auth.ok ? "available" : `unavailable (${auth.reason} — learning jobs will fail)`);
    if (opts.allowOrigin && opts.allowOrigin.length > 0) {
      log.meta("cors", opts.allowOrigin.join(", "));
    }
    log.info(`listening at http://localhost:${boundPort}`);
  });
}
