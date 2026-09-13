import { resolve } from "node:path";
import { isWithin } from "../targets/resources.ts";
import { citedPath } from "./verify-citations.ts";
import type { DriftDiagnosis } from "./types.ts";

export interface WritableArea {
  cwd: string;
  /** The target's `writeRoots`, as configured. Empty means "not declared". */
  writeRoots: readonly string[];
  /** Where this case's generated test lands, project-relative. */
  testPath: string | null;
  /** Absolute product-source roots — where the finding's *other* half lives. */
  sourceRoots: readonly string[];
}

/**
 * Put a finding back on the surface the files it cites belong to.
 *
 * An audit reads the generated test *and everything it imports*, which reaches
 * a project's own shared assets — and `generated` is the answer that costs: it
 * routes a fix job to regenerate, which reuses a file it only imports.
 *
 * Only the files a repair would edit decide this. A citation into the product's
 * own source is the other half of every drift finding — what the product now
 * renders — and counting it would demote the ordinary selector drift this
 * exists to leave alone. Corrected when what is left is non-empty and ccqa
 * writes none of it, and only when the project has declared `writeRoots`:
 * without one, ccqa writes wherever its resources allow and "outside" is not
 * answerable.
 */
export function correctSurface(drift: DriftDiagnosis, area: WritableArea): void {
  if (drift.surface !== "generated") return;
  const outside = repairTargetsOutside(drift.evidence, area);
  if (outside === null) return;
  drift.surface = "spec";
  drift.reasoning =
    `${drift.reasoning}\n\n[ccqa] Reported on the generated surface, corrected: ` +
    `${outside.join(", ")} — outside this target's writeRoots, so regenerating this case ` +
    `would not touch what the finding is about.`;
}

/** The cited files a repair would edit, when ccqa writes none of them. */
function repairTargetsOutside(
  evidence: ReadonlyArray<{ file?: string }>,
  area: WritableArea,
): string[] | null {
  if (area.writeRoots.length === 0) return null;
  // The generated file itself, not the directory holding it: a flat
  // `{case}.spec.ts` template would otherwise claim the whole project.
  const mine = [
    ...area.writeRoots.map((root) => resolve(area.cwd, root)),
    ...(area.testPath === null ? [] : [resolve(area.cwd, area.testPath)]),
  ];
  const outside: string[] = [];
  for (const cited of new Set(evidence.map((e) => e.file).filter((f): f is string => !!f).map(citedPath))) {
    const abs = resolve(area.cwd, cited);
    if (area.sourceRoots.some((root) => isWithin(root, abs))) continue;
    if (mine.some((root) => isWithin(root, abs))) return null;
    outside.push(cited);
  }
  return outside.length > 0 ? outside : null;
}
