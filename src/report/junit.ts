import { relative, resolve } from "node:path";
import { toPosix } from "./evidence.ts";
import type { LiveReportStep, ReportSpecResult, RunReportData } from "./schema.ts";

/**
 * XML 1.0's Char production forbids these bytes outright, even escaped — a
 * control character other than tab/LF/CR. A model's reasoning can contain
 * one, and a stray byte must not produce a file no parser will open, so it
 * is dropped rather than escaped. \x7F (DEL) is not in that forbidden set —
 * XML 1.0 permits it — so it is left alone.
 */
function stripInvalidXmlChars(raw: string): string {
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
}

function escapeXmlText(raw: string): string {
  return stripInvalidXmlChars(raw).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Attribute-value normalization (XML 1.0 §3.3.3) turns a literal newline,
 * CR, or tab into a space before a parser ever sees it, which would flatten
 * a multi-line failure reason. Numeric character references survive
 * normalization intact, so encode those three here; text content keeps the
 * real characters.
 */
function escapeXmlAttr(raw: string): string {
  return escapeXmlText(raw)
    .replace(/"/g, "&quot;")
    .replace(/\n/g, "&#10;")
    .replace(/\r/g, "&#13;")
    .replace(/\t/g, "&#9;");
}

function caseId(row: ReportSpecResult): string {
  return `${row.feature}/${row.spec}`;
}

/** Milliseconds to a JUnit-style seconds string, three decimals. */
function seconds(ms: number | null | undefined): string {
  return ((ms ?? 0) / 1000).toFixed(3);
}

/** The step a live row's failure is attributed to, or null for a passed/non-live row. */
function firstFailedStep(row: ReportSpecResult): LiveReportStep | null {
  return row.liveRun?.steps.find((s) => s.status === "failed") ?? null;
}

/** One-line failure reason for the `<failure message>` attribute — cheapest signal first. */
function failureMessage(row: ReportSpecResult): string {
  const step = firstFailedStep(row);
  if (step?.reasoning) return step.reasoning;
  if (row.analysis?.headline) return row.analysis.headline;
  const firstLine = row.failureLogExcerpt?.split("\n")[0];
  if (firstLine) return firstLine;
  return "failed";
}

/** The fuller failure detail carried in the `<failure>` element body. */
function failureBody(row: ReportSpecResult): string {
  const step = firstFailedStep(row);
  if (step) {
    return [
      `Step ${step.stepId} failed`,
      `Instruction: ${step.instruction}`,
      `Expected: ${step.expected}`,
      `Reasoning: ${step.reasoning}`,
    ].join("\n");
  }
  return row.failureLogExcerpt ?? "";
}

/** A row's stored path (relative to `reportDir`), re-expressed relative to where the XML itself lives. */
function rewriteEvidencePath(storedPath: string, reportDir: string, junitDir: string): string {
  return toPosix(relative(junitDir, resolve(reportDir, storedPath)));
}

/** Step-boundary screenshot paths for one row, in capture order, for `<system-out>`. */
function evidencePaths(row: ReportSpecResult, reportDir: string, junitDir: string): string[] {
  const stored = row.liveRun
    ? row.liveRun.steps.flatMap((s) => [s.beforePng, s.afterPng].filter((p): p is string => p !== null))
    : (row.evidence ?? []).flatMap((e) =>
        [e.beforePngPath ?? null, e.pngPath].filter((p): p is string => p !== null),
      );
  return stored.map((p) => rewriteEvidencePath(p, reportDir, junitDir));
}

function renderTestcase(row: ReportSpecResult, reportDir: string, junitDir: string): string {
  const name = row.title ?? caseId(row);
  const attrs =
    `name="${escapeXmlAttr(name)}" classname="${escapeXmlAttr(caseId(row))}" ` +
    `time="${seconds(row.durationMs)}"`;
  const children: string[] = [];
  if (row.status === "failed") {
    children.push(
      `<failure message="${escapeXmlAttr(failureMessage(row))}">${escapeXmlText(failureBody(row))}</failure>`,
    );
  } else if (row.status === "skipped") {
    children.push(row.skipReason ? `<skipped message="${escapeXmlAttr(row.skipReason)}"/>` : "<skipped/>");
  }
  const paths = evidencePaths(row, reportDir, junitDir);
  if (paths.length > 0) {
    children.push(`<system-out>${escapeXmlText(paths.join("\n"))}</system-out>`);
  }
  return children.length === 0 ? `<testcase ${attrs}/>` : `<testcase ${attrs}>${children.join("")}</testcase>`;
}

/**
 * Render a run report as JUnit XML, so an external CI or test-management tool
 * can read `ccqa run`'s results with no ccqa-specific parsing. Deterministic —
 * no timestamps, and `results` is an array so row order is already fixed —
 * so two renders of the same report byte-match.
 *
 * `paths.reportDir` is what each row's stored screenshot paths are relative
 * to; `paths.junitDir` is the directory the XML file itself will be written
 * to (commonly a different directory, via `--report-junit`). Each
 * `<system-out>` path is re-expressed relative to `junitDir` so it resolves
 * from the XML's own location.
 */
export function renderJunitXml(report: RunReportData, paths: { reportDir: string; junitDir: string }): string {
  const rows = report.results;
  const failures = rows.filter((r) => r.status === "failed").length;
  const skipped = rows.filter((r) => r.status === "skipped").length;
  const totalMs = rows.reduce((sum, r) => sum + (r.durationMs ?? 0), 0);
  const suiteAttrs =
    `name="ccqa" tests="${rows.length}" failures="${failures}" ` +
    `skipped="${skipped}" time="${seconds(totalMs)}"`;
  const testcases = rows.map((r) => renderTestcase(r, paths.reportDir, paths.junitDir)).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites><testsuite ${suiteAttrs}>${testcases}</testsuite></testsuites>\n`;
}
