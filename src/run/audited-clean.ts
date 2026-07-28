import type { HubContext } from "../cli/hub-conn.ts";
import { specKey } from "../store/index.ts";
import { RunUsageError } from "./errors.ts";
import { errMessage } from "./errors.ts";

/**
 * The drift ledger reduced to what selection needs: which specs were audited
 * at all, and which of those came back clean. Both are needed to tell "the
 * audit found drift" from "nobody has looked yet" in the log line.
 */
export interface AuditedLedger {
  clean: ReadonlySet<string>;
  audited: ReadonlySet<string>;
}

/**
 * Fetch the drift ledger and reduce it to the specs that are safe to run.
 *
 * A spec qualifies only when the ledger holds an entry for it *and* that entry
 * found no drift. A spec that has never been audited does not qualify: the
 * point of the flag is to spend a run only where a cheap audit already said
 * the spec still describes the code, and "never looked" is not that.
 */
export async function fetchAuditedLedger(hubCtx: HubContext): Promise<AuditedLedger> {
  let ledger;
  try {
    ledger = await hubCtx.hub.getDriftLedger(hubCtx.project);
  } catch (err) {
    throw new RunUsageError(
      `--only-hub-audited-clean: could not fetch the drift ledger from the hub: ${errMessage(err)}`,
    );
  }
  const clean = new Set<string>();
  const audited = new Set<string>();
  for (const [key, entry] of Object.entries(ledger.specs)) {
    audited.add(key);
    if (entry.label === null) clean.add(key);
  }
  return { clean, audited };
}

export interface AuditedCleanSelection {
  selected: Array<{ featureName: string; specName: string }>;
  /** Dropped because the ledger has no entry at all — never audited. */
  unaudited: number;
  /** Dropped because the audit found drift. */
  drifted: number;
}

export function selectAuditedClean(
  specs: readonly { featureName: string; specName: string }[],
  ledger: AuditedLedger,
): AuditedCleanSelection {
  const selected: Array<{ featureName: string; specName: string }> = [];
  let unaudited = 0;
  let drifted = 0;
  for (const spec of specs) {
    const key = specKey(spec);
    if (ledger.clean.has(key)) selected.push(spec);
    else if (ledger.audited.has(key)) drifted++;
    else unaudited++;
  }
  return { selected, unaudited, drifted };
}
