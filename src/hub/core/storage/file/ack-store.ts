import { AckSchema, type Ack } from "../../../contract/schema.ts";
import type { AckStore } from "../types.ts";
import { assertSafeName, readJson, writeJson } from "./fs-helpers.ts";
import { ackPath } from "./paths.ts";

function assertSafeKey(project: string, profile: string, name: string): void {
  assertSafeName(project, "project");
  assertSafeName(profile, "profile");
  assertSafeName(name, "name");
}

/**
 * Ack storage: one JSON document per (project, profile, name). A write
 * replaces the document outright, so unlike the ledgers there is no
 * read-modify-write to serialize — but it still goes through `writeJson`'s
 * temp-then-rename, so a concurrent reader never sees a half-written set.
 */
export function createFileAckStore(root: string): AckStore {
  return {
    async get(project, profile, name) {
      assertSafeKey(project, profile, name);
      const parsed = AckSchema.safeParse(await readJson<unknown>(ackPath(root, project, profile, name)));
      return parsed.success ? parsed.data : { keys: [], at: null };
    },

    async put(project, profile, name, keys) {
      assertSafeKey(project, profile, name);
      const ack: Ack = { keys, at: new Date().toISOString() };
      await writeJson(ackPath(root, project, profile, name), ack);
      return ack;
    },
  };
}
