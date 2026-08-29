import { parse as parseYaml } from "yaml";
import { ZodError } from "zod";
import { BlockSpecSchema, TestSpecSchema, type BlockSpec, type TestSpec } from "./yaml-schema.ts";

/**
 * Fields the schema used to accept, and what to do now. The schema is
 * `.strict()`, so a spec still carrying one fails on an "unrecognized key"
 * that says nothing about why it stopped being recognised. Folded into
 * `humanizeIssue`'s `unrecognized_keys` branch (below) rather than checked
 * ahead of validation, so the migration note reaches both `parseTestSpec` and
 * `parseBlockSpec` through the one place that already rewrites that error.
 *
 * `at` scopes an entry to where the schema used to accept the field; the
 * same key anywhere else keeps the generic unknown-key rendering.
 */
interface RemovedField {
  at: (path: (string | number)[]) => boolean;
  message: string;
}

/** The spec/block root (an `unrecognized_keys` issue there has an empty path). */
const atRoot = (path: (string | number)[]) => path.length === 0;

/** A block param entry — the issue path is `params.<index>`. */
const atBlockParam = (path: (string | number)[]) =>
  path.length === 2 && path[0] === "params" && typeof path[1] === "number";

const UNREAD_PARAM_FIELD =
  "nothing reads it (a block param reaches the prompts as its name, required and secret only). Delete the line.";

const REMOVED_FIELDS: Record<string, RemovedField> = {
  relatedPaths: {
    at: atRoot,
    message:
      "which specs a change affects is now decided by `ccqa select-specs`, which reads the diff instead of a declared path list. Delete the field.",
  },
  dummy: { at: atBlockParam, message: UNREAD_PARAM_FIELD },
  description: { at: atBlockParam, message: UNREAD_PARAM_FIELD },
};

/** Parse a spec.yaml. Schema rejections are rewritten with actionable messages. */
export function parseTestSpec(content: string, source = "spec.yaml"): TestSpec {
  const raw = parseYamlOrThrow(content, source);
  try {
    return TestSpecSchema.parse(raw);
  } catch (e) {
    throw enrichZodError(e, source, /* isBlock */ false, raw);
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
    throw enrichZodError(e, source, /* isBlock */ true, raw);
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
  errors?: ZodLikeIssue[][];
  path: (string | number)[];
  message: string;
}

function enrichZodError(error: unknown, source: string, isBlock: boolean, raw: unknown): Error {
  if (!(error instanceof ZodError)) return error as Error;

  const lines: string[] = [`Invalid ${source}:`];
  for (const issue of error.issues as unknown as ZodLikeIssue[]) {
    for (const [path, message] of explain(issue, isBlock, raw)) {
      lines.push(`  - ${path.join(".") || "(root)"}: ${message}`);
    }
  }
  return new Error(lines.join("\n"));
}

const NESTED_BLOCK_MESSAGE =
  "Nested blocks are not supported — flatten by inlining the included block's steps into this block.";

/**
 * The issues actually worth showing for one failure. A step is a union, so
 * anything wrong with it fails as a whole and says only "Invalid input" —
 * useless. The branch the author meant is the one that recognized the most of
 * what they wrote, so its own issues are reported instead.
 */
type Reported = [path: (string | number)[], message: string];

function explain(issue: ZodLikeIssue, isBlock: boolean, raw: unknown): Reported[] {
  const asIs: Reported[] = [[issue.path, humanizeIssue(issue, isBlock, raw)]];
  if (issue.code !== "invalid_union" || !issue.errors?.length) return asIs;
  // A nested block fails every branch equally, so the advice cannot be
  // recovered from any of them — it comes from the value.
  if (isBlock && stepKind(raw, issue.path) === "include") return asIs;
  const best = pickBranch(issue.errors, stepKind(raw, issue.path));
  if (!best?.length) return asIs;
  // Paths are relative to the union node, so the caller's scoping (which
  // removed field belongs to the root) needs them made absolute first.
  return best.map((b) => {
    const path = [...issue.path, ...b.path];
    return [path, humanizeIssue({ ...b, path }, isBlock, raw)];
  });
}

/** Which kind of step the author was writing, read from the key they used. */
function stepKind(raw: unknown, path: (string | number)[]): string | null {
  const node = nodeAt(raw, path);
  if (!isRecord(node)) return null;
  for (const key of ["include", "judgeByLlm"]) if (key in node) return key;
  return "instruction";
}

/**
 * The branch the author meant: the one that accepts the key they wrote. Any
 * other branch reports that key as unrecognized, which would tell them the
 * key they just used does not exist. Ties among the rest go to the branch
 * that recognized the most of what they wrote.
 */
function pickBranch(branches: ZodLikeIssue[][], kind: string | null): ZodLikeIssue[] | undefined {
  const accepts = kind === null ? branches : branches.filter((b) => !rejectsKey(b, kind));
  const candidates = accepts.length > 0 ? accepts : branches;
  return candidates.reduce((a, b) => (unknownKeyCount(a) <= unknownKeyCount(b) ? a : b));
}

function rejectsKey(issues: ZodLikeIssue[], key: string): boolean {
  return issues.some((i) => Array.isArray(i.keys) && (i.keys as string[]).includes(key));
}

function unknownKeyCount(issues: ZodLikeIssue[]): number {
  return issues.reduce((n, i) => n + (Array.isArray(i.keys) ? i.keys.length : 0), 0);
}

function humanizeIssue(issue: ZodLikeIssue, isBlock: boolean, raw: unknown): string {
  if (isBlock && issue.code === "invalid_union" && stepKind(raw, issue.path) === "include") {
    return NESTED_BLOCK_MESSAGE;
  }
  if (issue.code === "unrecognized_keys") {
    const keys = Array.isArray(issue.keys) ? (issue.keys as string[]) : [];
    if (isBlock && keys.includes("include")) {
      return NESTED_BLOCK_MESSAGE;
    }
    const removed = keys.filter((k) => REMOVED_FIELDS[k]?.at(issue.path));
    const stillUnknown = keys.filter((k) => !REMOVED_FIELDS[k]?.at(issue.path));
    const parts = removed.map(
      (k) => `\`${k}\` is no longer part of the spec schema — ${REMOVED_FIELDS[k]!.message}`,
    );
    if (stillUnknown.length > 0) parts.push(`Unknown keys: ${stillUnknown.join(", ")}`);
    return parts.join(" ");
  }
  return issue.message;
}

function nodeAt(raw: unknown, path: (string | number)[]): unknown {
  let node: unknown = raw;
  for (const segment of path) {
    if (!isRecord(node)) return undefined;
    node = node[segment];
  }
  return node;
}

function isRecord(value: unknown): value is Record<string | number, unknown> {
  return typeof value === "object" && value !== null;
}
