import { HttpError } from "../api/respond.ts";
import type { PerspectivesStore } from "./storage/types.ts";

/**
 * One spec as re-run selection sees it: its ledger key. Re-run verdicts come
 * from the per-deploy touch index (`ccqa select-specs`, ADR-0011), not from
 * anything carried on the spec itself — this exists to enumerate the keys
 * `computeRerun` needs a verdict for.
 */
export interface SpecTarget {
  /** "feature/spec" — the same key the spec ledger uses. */
  key: string;
  /**
   * When the spec was last edited (ISO 8601), as the inventory recorded it.
   * Absent on documents written before `ccqa perspectives` carried it.
   */
  changedAt?: string;
}

function prop(obj: unknown, key: string): unknown {
  return (obj as Record<string, unknown> | null | undefined)?.[key];
}

/**
 * Pull the spec targets out of a stored perspectives document.
 *
 * Hand-parsed rather than run through `PerspectivesSchema`, because the
 * document on the hub was written by whatever CLI version the consumer runs:
 * a single malformed entry must cost that one spec, not fail the whole view.
 */
export function readSpecTargets(doc: unknown): SpecTarget[] {
  const features = prop(doc, "features");
  if (!Array.isArray(features)) return [];
  const out: SpecTarget[] = [];
  for (const feature of features) {
    const featureName = prop(feature, "featureName");
    const specs = prop(feature, "specs");
    if (typeof featureName !== "string" || !Array.isArray(specs)) continue;
    for (const spec of specs) {
      const specName = prop(spec, "specName");
      if (typeof specName !== "string") continue;
      // Listed but opted out of runs and audits. It stays in the document so
      // the inventory keeps it and its note survives; this is the one place
      // that has to skip it, since everything asking "which specs" starts here.
      if (prop(spec, "disabled") === true) continue;
      const changedAt = prop(spec, "changedAt");
      out.push({
        key: `${featureName}/${specName}`,
        ...(typeof changedAt === "string" && changedAt ? { changedAt } : {}),
      });
    }
  }
  return out;
}

/**
 * The project's spec targets as stored on the hub, or null when it has no
 * perspectives document — the one condition `GET /rerun` answers with a 404,
 * and the one that leaves a deploy with nothing to fold against.
 */
export async function loadSpecTargets(
  perspectives: PerspectivesStore,
  project: string,
): Promise<SpecTarget[] | null> {
  const stored = await perspectives.get(project);
  if (!stored) return null;
  try {
    return readSpecTargets(JSON.parse(Buffer.from(stored).toString("utf8")));
  } catch {
    // A document the hub can't parse is as unusable as a missing one, and the
    // hub never wrote it — the CLI pushes it verbatim.
    return null;
  }
}

/**
 * The same, but throwing the 404 both selection endpoints answer with. The
 * code is distinct from the generic `not_found` an unrouted path returns: the
 * route exists, the project's perspectives document does not. Clients tell
 * "this hub is too old" from "push a perspectives document" by this code
 * alone, with no second probe request.
 */
export async function requireSpecTargets(
  perspectives: PerspectivesStore,
  project: string,
  question: string,
): Promise<SpecTarget[]> {
  const specs = await loadSpecTargets(perspectives, project);
  if (specs === null) {
    throw new HttpError(
      404,
      "no_perspectives",
      `no perspectives stored for project "${project}" — push one with \`ccqa perspectives\` before asking ${question}`,
    );
  }
  return specs;
}
