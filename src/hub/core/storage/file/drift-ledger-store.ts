import { join } from "node:path";
import type { DriftLedger } from "../../../contract/schema.ts";
import { emptyDriftLedger, mergeDriftLedgerInto, toDriftLedger } from "../../drift-ledger.ts";
import type { DriftLedgerStore } from "../types.ts";
import { listDirOrEmpty, readJson, updateJson } from "./fs-helpers.ts";
import { driftLedgerPath, driftLedgerProjectDir } from "./paths.ts";

export function createFileDriftLedgerStore(root: string): DriftLedgerStore {
  return {
    async getMerged(project) {
      const dir = driftLedgerProjectDir(root, project);
      const files = (await listDirOrEmpty(dir)).filter((name) => name.endsWith(".json"));
      const docs = await Promise.all(files.map((name) => readJson<unknown>(join(dir, name))));
      return docs.reduce<DriftLedger>((acc, doc) => mergeDriftLedgerInto(acc, toDriftLedger(doc)), emptyDriftLedger());
    },

    async merge(project, branch, ledger) {
      // The whole read-modify-write stays inside one `updateJson` critical
      // section, so two runs finalizing at once can't both merge onto the
      // same starting document and lose one of the two.
      await updateJson<unknown>(driftLedgerPath(root, project, branch), (current) =>
        mergeDriftLedgerInto(toDriftLedger(current), ledger),
      );
    },
  };
}
