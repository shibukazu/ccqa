import { parse as parseYaml } from "yaml";
import {
  PerspectivesSchema,
  type PerspectiveFeature,
  type Perspectives,
  type PerspectiveSpec,
} from "../types.ts";
import { tryReadSpecFile, type SpecRef } from "../store/index.ts";
import { deriveStatus, readSpecMeta, requestSummaries } from "./perspectives.ts";
import type { HubContext } from "./hub-conn.ts";
import * as log from "./logger.ts";

export interface SyncSpecPerspectivesOptions {
  ref: SpecRef;
  language?: string;
  model?: string;
}

/**
 * Best-effort incremental update of the hub-stored perspectives document
 * after a successful `ccqa record` / `ccqa generate`: upsert just this spec's
 * entry (mechanical facts recomputed, descriptive fields rewritten by one
 * small Claude call, the human `note` preserved). The full `ccqa perspectives`
 * run remains the way to regenerate everything and prune deleted specs.
 *
 * Never fails the caller: no hub configured → no-op; any error → warning.
 */
export async function syncSpecPerspectives(
  hubContext: HubContext | null,
  opts: SyncSpecPerspectivesOptions,
): Promise<void> {
  if (!hubContext) return;
  try {
    await doSync(hubContext, opts);
  } catch (err) {
    log.warn(`perspectives auto-update skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function doSync(ctx: HubContext, opts: SyncSpecPerspectivesOptions): Promise<void> {
  const { featureName, specName } = opts.ref;
  const specYaml = await tryReadSpecFile(featureName, specName);
  if (specYaml === null) return;

  const existing = await ctx.hub.getPerspectives(ctx.project);
  let doc: Perspectives;
  if (existing === null) {
    doc = { generatedAt: new Date().toISOString(), features: [] };
  } else {
    const parsed = PerspectivesSchema.safeParse(existing);
    if (!parsed.success) {
      // Don't clobber a document we can't read — that would drop every other
      // spec's entry. Leave it to a full regeneration.
      log.warn(
        "perspectives auto-update skipped: the hub document does not match the schema — run `ccqa perspectives` to regenerate it",
      );
      return;
    }
    doc = parsed.data;
  }

  const meta = await readSpecMeta(featureName, specName);
  const status = await deriveStatus(featureName, specName, meta.mode);
  const relatedPaths = extractRelatedPaths(specYaml);
  const previous = findSpec(doc, featureName, specName);

  // One-spec Claude call for the descriptive fields; on failure fall back to
  // whatever the document already said so the mechanical update still lands.
  const summaries = await requestSummaries(
    [{ featureName, specName, title: meta.title, specYaml }],
    { ...(opts.language ? { language: opts.language } : {}), ...(opts.model ? { model: opts.model } : {}) },
  );
  const written = summaries?.[0];

  const entry: PerspectiveSpec = {
    specName,
    title: meta.title,
    summary: written?.summary ?? previous?.summary ?? "",
    status,
  };
  const startScreen = written?.startScreen ?? previous?.startScreen;
  if (startScreen) entry.startScreen = startScreen;
  const testCondition = written?.testCondition ?? previous?.testCondition;
  if (testCondition) entry.testCondition = testCondition;
  const preconditions = written?.preconditions ?? previous?.preconditions;
  if (preconditions && preconditions.length > 0) entry.preconditions = preconditions;
  if (relatedPaths.length > 0) entry.relatedPaths = relatedPaths;
  if (previous?.note) entry.note = previous.note;

  upsertSpec(doc, featureName, entry);
  doc.generatedAt = new Date().toISOString();
  await ctx.hub.putPerspectives(ctx.project, PerspectivesSchema.parse(doc));
  log.meta("perspectives", `updated ${featureName}/${specName} on the hub`);
}

function findSpec(doc: Perspectives, featureName: string, specName: string): PerspectiveSpec | undefined {
  return doc.features
    .find((f) => f.featureName === featureName)
    ?.specs.find((s) => s.specName === specName);
}

/** Replace-or-insert the spec entry, keeping features and specs name-sorted like a full regeneration. */
export function upsertSpec(doc: Perspectives, featureName: string, entry: PerspectiveSpec): void {
  let feature: PerspectiveFeature | undefined = doc.features.find((f) => f.featureName === featureName);
  if (!feature) {
    feature = { featureName, specs: [] };
    doc.features.push(feature);
    doc.features.sort((a, b) => a.featureName.localeCompare(b.featureName));
  }
  const idx = feature.specs.findIndex((s) => s.specName === entry.specName);
  if (idx >= 0) {
    feature.specs[idx] = entry;
  } else {
    feature.specs.push(entry);
    feature.specs.sort((a, b) => a.specName.localeCompare(b.specName));
  }
}

/** `relatedPaths` transcribed verbatim from the spec.yaml (empty when absent/unparsable). */
export function extractRelatedPaths(specYaml: string): string[] {
  try {
    const parsed = parseYaml(specYaml) as { relatedPaths?: unknown };
    if (!Array.isArray(parsed?.relatedPaths)) return [];
    return parsed.relatedPaths.filter((p): p is string => typeof p === "string" && p.length > 0);
  } catch {
    return [];
  }
}
