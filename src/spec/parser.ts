import { parse as parseYaml } from "yaml";
import { ZodError } from "zod";
import {
  BlockSpecSchema,
  TestSpecSchema,
  type BlockSpec,
  type TestSpec,
} from "./yaml-schema.ts";

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
    return `Unknown keys: ${keys.join(", ")}`;
  }
  return issue.message;
}
