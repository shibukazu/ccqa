import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { createHubServer } from "../../../src/hub/api/server.ts";
import { createFileHubStorage } from "../../../src/hub/core/storage/file/index.ts";
import type { HubStorage } from "../../../src/hub/core/storage/types.ts";

export interface TestHub {
  baseUrl: string;
  /** The same storage the server reads, for seeding fixtures and asserting on state. */
  storage: HubStorage;
  server: Server;
  /** Shuts the server down and removes its data directory. */
  close(): Promise<void>;
}

/**
 * A real hub on a real port, backed by a throwaway data directory — what the
 * hub-facing e2e scenarios drive the CLI against. Port 0 so parallel test files
 * never collide.
 */
export async function startTestHub(opts: { token: string }): Promise<TestHub> {
  const dataDir = await mkdtemp(join(tmpdir(), "ccqa-e2e-hub-"));
  const storage = createFileHubStorage(dataDir);
  const server = createHubServer({ storage, token: opts.token, encryptionKey: null, allowedOrigins: [] });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected a bound TCP address");

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    storage,
    server,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}
