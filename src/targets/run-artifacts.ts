import { readdir, stat } from "node:fs/promises";
import { join, posix as posixPath } from "node:path";
import type { ReportArtifact } from "../report/schema.ts";
import { ARTIFACTS_SUBDIR } from "../run/report-constants.ts";

/**
 * Per-spec artifacts collection for external (runCommand) targets: the run
 * pipeline gives each spec a directory under the report dir, the command
 * writes whatever it wants there (Playwright traces, runn captures, ...), and
 * after the run every file inside becomes a report `artifacts` entry the hub
 * UI can render. Shared by the run-side runner (run-command-runner.ts) and
 * the generate-side verification loop (llm-engine.ts substitutes the same
 * template variable, pointed at a throwaway dir).
 */

/** `runCommand` template variable expanded to the spec's artifacts directory. */
export const ARTIFACTS_DIR_VAR = "{artifactsDir}";

/**
 * Env var carrying the artifacts directory to the child process, for commands
 * that can't take the directory as a flag. Always set, template or not.
 */
export const ARTIFACTS_DIR_ENV = "CCQA_ARTIFACTS_DIR";

/** The runner's full stdout+stderr capture, always written into the artifacts dir. */
export const OUTPUT_LOG_FILE = "output.log";

/** What Playwright names the trace it writes under the output dir, one per test. */
const TRACE_ARCHIVE_FILE = "trace.zip";

/** Whether a path under the artifacts dir names one of those traces. */
export function isTraceArchive(rel: string): boolean {
  return rel === TRACE_ARCHIVE_FILE || rel.endsWith(`/${TRACE_ARCHIVE_FILE}`);
}

/**
 * Caps on what one spec's artifacts dir may contribute to the report. The
 * byte cap matches the hub's default push cap (`serve --max-push-mb`, 32 MB)
 * so a collected report bundle stays pushable. `output.log` is exempt: the
 * report must always say what ran.
 */
export const MAX_ARTIFACT_FILES = 50;
export const MAX_ARTIFACT_TOTAL_BYTES = 32 * 1024 * 1024;

/** `<reportDir>/artifacts/<feature>__<spec>` — created before the runCommand runs. */
export function specArtifactsDir(reportDir: string, feature: string, spec: string): string {
  return join(reportDir, ARTIFACTS_SUBDIR, `${feature}__${spec}`);
}

/**
 * Expand `{artifactsDir}` (shell-quoted — the report dir path may contain
 * spaces). A command without the placeholder runs verbatim; it still receives
 * the directory via CCQA_ARTIFACTS_DIR.
 */
export function substituteArtifactsDir(command: string, artifactsDir: string): string {
  return command.replaceAll(ARTIFACTS_DIR_VAR, quoteForShell(artifactsDir));
}

/** Single quotes survive every shell metacharacter except themselves. */
export function quoteForShell(s: string): string {
  return /^[A-Za-z0-9_./-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`;
}

const KIND_BY_EXT: Record<string, ReportArtifact["kind"]> = {
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  json: "json",
  txt: "text",
  log: "text",
  md: "text",
  yaml: "text",
  yml: "text",
  xml: "text",
};

/** Rendering kind from the file extension; anything unrecognized is "binary" (download-only). */
export function inferArtifactKind(fileName: string): ReportArtifact["kind"] {
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0) return "binary";
  return KIND_BY_EXT[fileName.slice(dot + 1).toLowerCase()] ?? "binary";
}

/**
 * Walk the spec's artifacts dir and turn every file into a report artifact
 * row, capped at MAX_ARTIFACT_FILES / MAX_ARTIFACT_TOTAL_BYTES. Files beyond
 * a cap are dropped from the *report row* only (they stay on disk) and each
 * drop is named in a warning — never silent. `output.log` sorts first and
 * bypasses the caps.
 */
export async function collectSpecArtifacts(args: {
  reportDir: string;
  feature: string;
  spec: string;
  /**
   * Whether the spec passed. A trace archive is tens of megabytes and is only
   * ever opened to replay a failure — the step screenshots were already read
   * out of it — so a passed spec does not list one. It stays on disk for
   * anyone who wants it; what it stops doing is filling the report and the
   * hub push with archives nobody opens.
   */
  passed: boolean;
  warn: (message: string) => void;
  /** Test seam — production callers use the module defaults. */
  caps?: { maxFiles: number; maxTotalBytes: number };
}): Promise<ReportArtifact[]> {
  const { maxFiles, maxTotalBytes } = args.caps ?? {
    maxFiles: MAX_ARTIFACT_FILES,
    maxTotalBytes: MAX_ARTIFACT_TOTAL_BYTES,
  };
  const dir = specArtifactsDir(args.reportDir, args.feature, args.spec);
  const relPrefix = posixPath.join(ARTIFACTS_SUBDIR, `${args.feature}__${args.spec}`);

  const relFiles = (await walkFiles(dir)).filter((rel) => !args.passed || !isTraceArchive(rel));
  // output.log first (the "what ran" anchor), traces last, then lexicographic
  // for stable rows.
  relFiles.sort((a, b) => rowRank(a) - rowRank(b) || a.localeCompare(b));

  const kept: ReportArtifact[] = [];
  const dropped: string[] = [];
  let totalBytes = 0;
  for (const rel of relFiles) {
    const { size } = await stat(join(dir, ...rel.split("/")));
    const overCap = kept.length >= maxFiles || totalBytes + size > maxTotalBytes;
    if (overCap && rel !== OUTPUT_LOG_FILE) {
      dropped.push(`${rel} (${formatBytes(size)})`);
      continue;
    }
    kept.push({
      name: rel,
      path: posixPath.join(relPrefix, rel),
      kind: inferArtifactKind(rel),
      sizeBytes: size,
    });
    totalBytes += size;
  }

  if (dropped.length > 0) {
    const shown = dropped.slice(0, 10).join(", ");
    const more = dropped.length > 10 ? ` … and ${dropped.length - 10} more` : "";
    args.warn(
      `artifacts capped for ${args.feature}/${args.spec} ` +
        `(max ${maxFiles} files / ${formatBytes(maxTotalBytes)} total); ` +
        `not listed in the report (still on disk): ${shown}${more}`,
    );
  }
  return kept;
}

/**
 * Where a file sits in the row order, and so which files the caps cut first.
 *
 * A Playwright trace is tens of megabytes and ccqa asks for one on every run
 * it can — taken before the rest of the budget it would be the whole of it,
 * and the screenshots and reports a reader actually opens would be the files
 * dropped. Ranked last it takes only what is left, and it is still on disk and
 * in the pushed bundle either way.
 */
function rowRank(rel: string): number {
  if (rel === OUTPUT_LOG_FILE) return 0;
  return isTraceArchive(rel) ? 2 : 1;
}

/** All files under `dir` as posix paths relative to it; missing dir → []. */
export async function walkFiles(dir: string, relBase = ""): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const rel = relBase === "" ? entry.name : `${relBase}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await walkFiles(join(dir, entry.name), rel)));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
