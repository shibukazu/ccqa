import { parse as parseYaml } from "yaml";
import { ZodError } from "zod";
import {
  BlockSpecSchema,
  TestSpecSchema,
  type BlockSpec,
  type TestSpec,
} from "./yaml-schema.ts";

/**
 * Fields the schema used to accept, and what to do now. The schema is
 * `.strict()`, so a spec still carrying one fails on an "unrecognized key"
 * that says nothing about why it stopped being recognised. Folded into
 * `humanizeIssue`'s `unrecognized_keys` branch (below) rather than checked
 * ahead of validation, so the migration note reaches both `parseTestSpec` and
 * `parseBlockSpec` through the one place that already rewrites that error.
 */
const REMOVED_FIELDS: Record<string, string> = {
  relatedPaths: "which specs a change affects is now decided by `ccqa select-specs`, which reads the diff instead of a declared path list. Delete the field.",
  dummy: "it was a block param placeholder for recording a block on its own, which no command does any more, and nothing else ever read it. Delete the line.",
  description: "it was a block param's prose note that no prompt ever received (a block list carries only a param's name, required and secret). Delete the line.",
};

/** Parse a spec.yaml. Schema rejections are rewritten with actionable messages. */
export function parseTestSpec(content: string, source = "spec.yaml"): TestSpec {
  const raw = parseYamlOrThrow(content, source);
  try {
    return TestSpecSchema.parse(raw);
  } catch (e) {
    throw enrichZodError(e, source, /* isBlock */ false);
  }
}

/**
 * Throw-suppressed sibling of `parseTestSpec`. Used by report-side helpers
 * that derive cosmetic data (title, step descriptions) from spec.yaml and
 * want a missing or malformed file to degrade silently rather than abort
 * the report.
 */
export function tryParseTestSpec(yaml: string | null): TestSpec | null {
  if (!yaml) return null;
  try {
    return parseTestSpec(yaml);
  } catch {
    return null;
  }
}

/**
 * Parse a block's spec.yaml. Block-specific errors include the targeted
 * nested-block message (the underlying zod failure on an `include` key
 * inside a block step is hard to read).
 */
export function parseBlockSpec(content: string, source = "block spec.yaml"): BlockSpec {
  const raw = parseYamlOrThrow(content, source);
  try {
    return BlockSpecSchema.parse(raw);
  } catch (e) {
    throw enrichZodError(e, source, /* isBlock */ true);
  }
}

function parseYamlOrThrow(content: string, source: string): unknown {
  try {
    return parseYaml(content);
  } catch (e) {
    throw new Error(`Failed to parse YAML (${source}): ${(e as Error).message}`);
  }
}

interface ZodLikeIssue {
  code?: string;
  keys?: unknown;
  path: (string | number)[];
  message: string;
}

function enrichZodError(error: unknown, source: string, isBlock: boolean): Error {
  if (!(error instanceof ZodError)) return error as Error;

  const lines: string[] = [`Invalid ${source}:`];
  for (const issue of error.issues as unknown as ZodLikeIssue[]) {
    const path = issue.path.join(".") || "(root)";
    const message = humanizeIssue(issue, isBlock);
    lines.push(`  - ${path}: ${message}`);
  }
  return new Error(lines.join("\n"));
}

function humanizeIssue(issue: ZodLikeIssue, isBlock: boolean): string {
  if (issue.code === "unrecognized_keys") {
    const keys = Array.isArray(issue.keys) ? (issue.keys as string[]) : [];
    if (isBlock && keys.includes("include")) {
      return `Nested blocks are not supported — flatten by inlining the included block's steps into this block.`;
    }
    const removed = keys.filter((k) => k in REMOVED_FIELDS);
    const stillUnknown = keys.filter((k) => !(k in REMOVED_FIELDS));
    const parts = removed.map((k) => `\`${k}\` is no longer part of the spec schema — ${REMOVED_FIELDS[k]}`);
    if (stillUnknown.length > 0) parts.push(`Unknown keys: ${stillUnknown.join(", ")}`);
    return parts.join(" ");
  }
  return issue.message;
}
