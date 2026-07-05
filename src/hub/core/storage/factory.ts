import type { HubStorage } from "./types.ts";
import { createFileHubStorage } from "./file/index.ts";

/**
 * v1 ships one backend (`file`). Adding another — SQLite, a remote DB — is a
 * two-step change: implement `HubStorage`'s sub-stores, then add one case
 * here. Nothing above this factory (the API layer) needs to change, since it
 * only ever depends on the `HubStorage` interface.
 */
export function createHubStorage(config: { driver: "file"; dataDir: string }): HubStorage {
  switch (config.driver) {
    case "file":
      return createFileHubStorage(config.dataDir);
  }
}
