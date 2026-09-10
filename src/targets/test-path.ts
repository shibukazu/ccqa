import { resolve } from "node:path";
import type { SpecRef } from "../store/index.ts";

/** The half of a target's config this module reads. */
interface TestPathConfig {
  testPath?: string;
}

/**
 * Where a target's generated test for one spec lives.
 *
 * The path is *derived* from a template, never recorded after the fact. `ccqa
 * run`, the drift audit, failure triage and perspectives all have to find a
 * spec's test without asking the generator, and a manifest written at generate
 * time is a second source of truth: it goes stale the moment a file moves, and
 * it lets a generation pass decide where the test lives. Deriving the path
 * makes "where is this spec's test" answerable from config alone — and makes
 * the answer the same before and after generation.
 *
 * The template language is deliberately tiny: `{placeholder}` segments filled
 * from a substitution table the caller owns. Today the table is the spec's own
 * coordinates (`{feature}` / `{spec}`); an intent source that names its cases
 * differently adds keys to the table without touching this module.
 */

const PLACEHOLDER = /\{([^{}]*)\}/g;

/**
 * Fill `{key}` placeholders from `values`. An unknown key is an error, not an
 * empty string: a typo'd placeholder would otherwise collapse every spec onto
 * a path that reads as deliberate.
 */
export function expandPathTemplate(template: string, values: Record<string, string>): string {
  return template.replaceAll(PLACEHOLDER, (_match, key: string) => {
    const value = values[key];
    if (value === undefined) {
      const known = Object.keys(values)
        .map((k) => `{${k}}`)
        .join(", ");
      throw new Error(`unknown placeholder {${key}} in "${template}" — available: ${known}`);
    }
    return value;
  });
}

/** The substitutions `resolveTestPath` fills in. */
const KNOWN_PLACEHOLDERS = ["feature", "spec"];

/**
 * Reject a template that cannot name a per-spec file inside the project.
 * Returns an error message, or null when the template is usable.
 */
export function validateTestPathTemplate(template: string): string | null {
  // Caught here so a typo is one config error, not a different failure in each
  // command that expands the template later.
  for (const [, key] of template.matchAll(PLACEHOLDER)) {
    if (!KNOWN_PLACEHOLDERS.includes(key!)) {
      return `testPath has no {${key}} to fill in — available: ${KNOWN_PLACEHOLDERS.map((k) => `{${k}}`).join(", ")}`;
    }
  }
  if (template.startsWith("/") || /^[A-Za-z]:[\\/]/.test(template)) {
    return "testPath must be relative to the project root";
  }
  if (template.split(/[\\/]+/).includes("..")) {
    return "testPath must not contain '..'";
  }
  if (!template.includes("{spec}")) {
    return "testPath must contain {spec}, or every spec would generate onto the same file";
  }
  return null;
}

/** The target's `testPath` when configured, else the target's own default. */
export function resolveTestPath(
  target: { defaultTestPath: string },
  targetConfig: TestPathConfig,
  ref: SpecRef,
): string {
  return expandPathTemplate(targetConfig.testPath ?? target.defaultTestPath, {
    feature: ref.featureName,
    spec: ref.specName,
  });
}

/** {@link resolveTestPath}, resolved against the project root. */
export function resolveTestPathAbs(
  target: { defaultTestPath: string },
  targetConfig: TestPathConfig,
  ref: SpecRef,
  cwd: string,
): string {
  return resolve(cwd, resolveTestPath(target, targetConfig, ref));
}
