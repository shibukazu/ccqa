import { execFileP, isPathAffectedBy } from "../drift/affected.ts";

/** Per-file cap keeps one giant generated file from monopolizing the prompt. */
export const PER_FILE_PATCH_CAP = 8 * 1024;
/** Total cap bounds the prompt regardless of how many files a PR touches. */
export const TOTAL_PATCH_CAP = 48 * 1024;

export interface PrDiff {
  /** Full unified diff of base...HEAD, paths relative to cwd. */
  patch: string;
  /** `git diff --name-status` output, paths relative to cwd. Cheap, never truncated. */
  nameStatus: string;
  /** Short HEAD sha. */
  head: string;
}

export type PrDiffResult = { ok: true; diff: PrDiff } | { ok: false; error: string };

/**
 * Capture the PR diff used as context for failure analysis. `--relative`
 * re-roots paths to `cwd` and drops changes outside it, matching how
 * relatedPaths are declared in a monorepo sub-package.
 *
 * Errors (unknown base ref, not a git repo, ...) are returned, not thrown:
 * the report is still worth generating without diff context.
 */
export async function capturePrDiff(base: string, cwd: string): Promise<PrDiffResult> {
  try {
    const [{ stdout: head }, { stdout: patch }, { stdout: nameStatus }] = await Promise.all([
      execFileP("git", ["rev-parse", "--short", "HEAD"], { cwd }),
      execFileP("git", ["diff", "-M", "--relative", `${base}...HEAD`], {
        cwd,
        maxBuffer: 64 * 1024 * 1024,
      }),
      execFileP("git", ["diff", "--name-status", "-M", "--relative", `${base}...HEAD`], {
        cwd,
        maxBuffer: 32 * 1024 * 1024,
      }),
    ]);
    return {
      ok: true,
      diff: { patch, nameStatus: nameStatus.trim(), head: head.trim() },
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message.split("\n")[0] ?? "git diff failed" };
  }
}

export interface PatchSection {
  /** Post-change path (the `b/` side of the `diff --git` header). */
  path: string;
  /** The full section text, including its `diff --git` header line. */
  body: string;
}

/**
 * Split a unified diff into per-file sections on `diff --git` boundaries.
 * The path is taken from the `b/` side so renames/edits key on the
 * post-change layout — the same side relatedPaths are written against.
 */
const DIFF_HEADER = /^diff --git a\/(.+) b\/(.+)$/;

export function splitPatchByFile(patch: string): PatchSection[] {
  const sections: PatchSection[] = [];
  const lines = patch.split("\n");
  let current: { path: string; lines: string[] } | null = null;

  const flush = () => {
    if (current) sections.push({ path: current.path, body: current.lines.join("\n") });
    current = null;
  };

  for (const line of lines) {
    const m = DIFF_HEADER.exec(line);
    if (m) {
      flush();
      current = { path: m[2]!, lines: [line] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  flush();
  return sections;
}

/**
 * Scope a full patch down to the files a spec depends on, then truncate so
 * the analysis prompt stays bounded. `relatedPaths` null/empty means the
 * spec is unscoped — keep the whole patch (still truncated). Callers scoping
 * the same patch for many specs can pass pre-split sections instead.
 */
export function scopePatchForSpec(
  patch: string | PatchSection[],
  relatedPaths: string[] | null | undefined,
  caps: { perFile?: number; total?: number } = {},
): string {
  const perFile = caps.perFile ?? PER_FILE_PATCH_CAP;
  const total = caps.total ?? TOTAL_PATCH_CAP;

  let sections = typeof patch === "string" ? splitPatchByFile(patch) : patch;
  if (relatedPaths && relatedPaths.length > 0) {
    const scoped = sections.filter((s) => isPathAffectedBy(s.path, relatedPaths));
    // When nothing in the diff matches the spec's relatedPaths, fall back to
    // the full diff: "no related change" is itself a strong PRODUCT_BUG
    // signal, but the model should see the actual changes to say so.
    if (scoped.length > 0) sections = scoped;
  }

  const parts: string[] = [];
  let used = 0;
  let droppedFiles = 0;
  for (const s of sections) {
    if (used >= total) {
      droppedFiles++;
      continue;
    }
    let body = s.body;
    if (body.length > perFile) {
      body = `${body.slice(0, perFile)}\n[truncated: ${body.length - perFile} more chars of ${s.path}]`;
    }
    if (used + body.length > total) {
      body = `${body.slice(0, total - used)}\n[truncated: total patch cap reached]`;
    }
    parts.push(body);
    used += body.length;
  }
  if (droppedFiles > 0) {
    parts.push(`[truncated: ${droppedFiles} more changed file(s) omitted]`);
  }
  return parts.join("\n");
}
