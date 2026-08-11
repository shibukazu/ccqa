import type { ExpandedActionStep } from "../spec/expand.ts";
import type { TestSpec } from "../spec/yaml-schema.ts";
import { isIncludeStep } from "../spec/yaml-schema.ts";
import { iterEnvRefNames } from "./env-vars.ts";

export interface SpecEnvScrub {
  /** `[envValue, "${VAR}"]` pairs, sorted long-to-short for safe replacement. */
  map: Array<[string, string]>;
  /** Refs unset (or empty) in both `overrides` and `process.env` at trace start. */
  unresolved: string[];
}

/**
 * Build a list of `[envValue, "${VAR}"]` pairs for every `${VAR}` reference
 * mentioned in the spec OR in any of its expanded (block-inlined) steps.
 * Used at trace time to scrub recorded Claude-text outputs so a value the
 * spec author intentionally threaded through `process.env` is preserved as
 * `${VAR}` in `ir.json` rather than baked in as the concrete
 * trace-time value.
 *
 * Why we walk `spec.steps` AND `expanded`:
 *   - `spec.steps` carries the spec's own `instruction` / `expected` + each
 *     include's raw `params` (which may themselves be `${ENV}` refs).
 *   - `expanded` carries the inlined block-internal steps, whose
 *     `instruction` / `expected` may *also* contain `${ENV}` refs that
 *     don't go through include params.
 *
 * Each ref resolves against `overrides` first, then `process.env` —
 * `overrides` carries values the invoker injects into the child process,
 * which beat the parent env there. Only refs that resolve non-empty land in
 * the map — scrubbing against an empty string would corrupt unrelated empty
 * strings in the action stream; the rest are returned via `unresolved` so
 * the caller can warn the user.
 *
 * Longer values sort first so a `${SHORT}` whose value is a substring of a
 * `${LONG}` value doesn't clobber the longer one.
 *
 * `title` is deliberately NOT scanned — it never reaches the recorded action
 * stream.
 */
export function buildSpecEnvScrub(
  spec: TestSpec,
  expanded: ExpandedActionStep[],
  overrides: Record<string, string> = {},
): SpecEnvScrub {
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
    // `overrides` carries values the invoker injects into the child process
    // (e.g. CCQA_RUN_ID), which beat the parent env there — so they beat it
    // here too, or the map would name a value the child never sees.
    const value = overrides[name] ?? process.env[name];
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

/** Shorter than this, a value is no secret and matches inside ordinary words. */
const MIN_PROSE_SCRUB_LENGTH = 4;

/** Long enough to clear the length bar, still ordinary prose / JSON. */
const COMMON_PROSE_VALUES = new Set(["true", "false", "null", "none", "undefined"]);

/**
 * Scrub map for model output, built like {@link buildSpecEnvScrub} but
 * without the values that read as ordinary text (`"1"`, `"true"`): prose
 * runs to paragraphs, where replacing every occurrence of such a value
 * costs more meaning than it protects. Record's own scrub keeps them for
 * its single command lines; the live path reuses this one map for its Bash
 * command log too, trading that short-value coverage for not building a
 * second map.
 */
export function buildProseEnvScrubMap(
  spec: TestSpec,
  expanded: ExpandedActionStep[],
  overrides: Record<string, string> = {},
): Array<[string, string]> {
  return buildSpecEnvScrub(spec, expanded, overrides).map.filter(
    ([value]) =>
      value.length >= MIN_PROSE_SCRUB_LENGTH && !COMMON_PROSE_VALUES.has(value.toLowerCase()),
  );
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
