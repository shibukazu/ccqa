import { join } from "node:path";
import type { SpecLedger } from "../../../contract/schema.ts";
import { emptyLedger, mergeLedgerInto, toLedger } from "../../spec-ledger.ts";
import type { SpecLedgerStore } from "../types.ts";
import { listDirOrEmpty, readJson, updateJson } from "./fs-helpers.ts";
import { ledgerPath, ledgerProfileDir } from "./paths.ts";

export function createFileSpecLedgerStore(root: string): SpecLedgerStore {
  return {
    async get(project, profile, branch) {
      return toLedger(await readJson<unknown>(ledgerPath(root, project, profile, branch)));
    },

    async getMerged(project, profile) {
      const dir = ledgerProfileDir(root, project, profile);
      const files = (await listDirOrEmpty(dir)).filter((name) => name.endsWith(".json"));
      const docs = await Promise.all(files.map((name) => readJson<unknown>(join(dir, name))));
      return docs.reduce<SpecLedger>((acc, doc) => mergeLedgerInto(acc, toLedger(doc)), emptyLedger());
    },

    async merge(project, profile, branch, ledger) {
      // The whole read-modify-write stays inside one `updateJson` critical
      // section, so two runs finalizing at once can't both merge onto the same
      // starting document and lose one of the two.
      await updateJson<unknown>(ledgerPath(root, project, profile, branch), (current) =>
        mergeLedgerInto(toLedger(current), ledger),
      );
    },
  };
}
