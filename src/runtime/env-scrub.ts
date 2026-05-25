import type { ExpandedActionStep } from "../spec/expand.ts";
import type { TestSpec } from "../spec/yaml-schema.ts";
import { isIncludeStep } from "../spec/yaml-schema.ts";
import { iterEnvRefNames } from "./env-vars.ts";

export interface SpecEnvScrub {
  /** `[envValue, "${VAR}"]` pairs, sorted long-to-short for safe replacement. */
  map: Array<[string, string]>;
  /** Refs whose `process.env` value was empty / unset at trace start. */
  unresolved: string[];
}

/**
 * Build a list of `[envValue, "${VAR}"]` pairs for every `${VAR}` reference
 * mentioned in the spec OR in any of its expanded (block-inlined) steps.
 * Used at trace time to scrub recorded Claude-text outputs so a value the
 * spec author intentionally threaded through `process.env` is preserved as
 * `${VAR}` in `actions.json` rather than baked in as the concrete
 * trace-time value.
 *
 * Why we walk `spec.steps` AND `expanded`:
 *   - `spec.steps` carries the spec's own `instruction` / `expected` + each
 *     include's raw `params` (which may themselves be `${ENV}` refs).
 *   - `expanded` carries the inlined block-internal steps, whose
 *     `instruction` / `expected` may *also* contain `${ENV}` refs that
 *     don't go through include params.
 *
 * Only refs whose env value is currently non-empty land in the map —
 * scrubbing against an empty string would corrupt unrelated empty strings
 * in the action stream. Names whose env is unset are returned via
 * `unresolved` so the caller can warn the user.
 *
 * Longer values sort first so a `${SHORT}` whose value is a substring of a
 * `${LONG}` value doesn't clobber the longer one.
 *
 * `title` and `relatedPaths` are deliberately NOT scanned — they never
 * reach the recorded action stream.
 */
export function buildSpecEnvScrub(spec: TestSpec, expanded: ExpandedActionStep[]): SpecEnvScrub {
  const refNames = new Set<string>();
  for (const step of spec.steps) {
    if (isIncludeStep(step)) {
      for (const v of Object.values(step.params ?? {})) collect(v, refNames);
    } else {
      collect(step.instruction, refNames);
      collect(step.expected, refNames);
    }
  }
  for (const step of expanded) {
    collect(step.instruction, refNames);
    collect(step.expected, refNames);
  }

  const map: Array<[string, string]> = [];
  const unresolved: string[] = [];
  for (const name of refNames) {
    const value = process.env[name];
    if (typeof value === "string" && value.length > 0) {
      map.push([value, "${" + name + "}"]);
    } else {
      unresolved.push(name);
    }
  }
  map.sort((a, b) => b[0].length - a[0].length);
  return { map, unresolved };
}

function collect(value: string, into: Set<string>): void {
  for (const name of iterEnvRefNames(value)) into.add(name);
}

/**
 * Replace every occurrence of an env value with its `${VAR}` placeholder in
 * `text`. **Caller invariant**: the map must be sorted longest-value-first
 * so a shorter value doesn't shadow a longer one that contains it as a
 * substring. `buildSpecEnvScrub` upholds this; hand-built maps should too.
 */
export function scrubEnvValues(text: string, scrubMap: Array<[string, string]>): string {
  if (scrubMap.length === 0) return text;
  let out = text;
  for (const [value, placeholder] of scrubMap) {
    if (out.includes(value)) out = out.replaceAll(value, placeholder);
  }
  return out;
}
