import type { PerspectivesStore } from "./storage/types.ts";

/**
 * One spec as re-run selection sees it: its ledger key and the source paths it
 * declares a dependency on. An empty `relatedPaths` means the spec cannot be
 * matched against a deploy at all — the caller reports that as `unknown`,
 * never as "not needed".
 */
export interface SpecTarget {
  /** "feature/spec" — the same key the spec ledger uses. */
  key: string;
  relatedPaths: string[];
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
      const related = prop(spec, "relatedPaths");
      out.push({
        key: `${featureName}/${specName}`,
        relatedPaths: Array.isArray(related) ? related.filter((p): p is string => typeof p === "string") : [],
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
