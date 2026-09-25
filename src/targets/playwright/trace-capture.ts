import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { parseStepLabel } from "../../codegen/step-comment.ts";
import { sanitizeStepId } from "../../runtime/evidence-constants.ts";
import { errMessage } from "../../run/errors.ts";
import { isTraceArchive, quoteForShell, walkFiles } from "../run-artifacts.ts";
import { parseTraceSteps, readTraceJsonl, type SnapshotRef } from "./trace-evidence.ts";
import { openSnapshotRenderer, type SnapshotRenderer } from "./trace-snapshot.ts";

/**
 * Per-step screenshots for a Playwright test that contains nothing of ccqa's.
 *
 * The test a project commits is plain `@playwright/test`: its steps are
 * `test.step` blocks and there is no capture call to place a screenshot at
 * either boundary. So the screenshots are not taken during the run at all —
 * ccqa asks Playwright for a trace on the invocations it owns, and afterwards
 * renders the DOM snapshots the trace took around each step's browser calls.
 * Nothing in the consumer's repository changes, and nothing ccqa does here can
 * turn a passing test red: the whole path runs after the command has exited,
 * and a trace it cannot read or render costs the report its pictures and says
 * so.
 */

/** Shell characters that would hand an appended flag to a different program. */
const SHELL_OPERATORS = /[|;&<>`$]/;

/**
 * The command has to reach `playwright test` itself for an appended flag to
 * mean anything. A package script that wraps it is one indirection too many —
 * the flag may be swallowed by the script runner, and a mangled command is a
 * worse outcome than no screenshots.
 */
const PLAYWRIGHT_TEST = /(^|\s)playwright\s+test(\s|$)/;

/**
 * The runCommand as ccqa must run it to get a trace back.
 *
 * Two shapes are refused rather than mangled: a command that reaches a second
 * program (the flag would land on the wrong one) and a command that already
 * directs its output somewhere ccqa does not read (the trace would be written
 * where nothing looks for it). A command that already asks for a trace keeps
 * its own setting — the project chose it, and `on` is what ccqa needs anyway
 * only when nothing else has spoken.
 *
 * A refusal answers `skip` with the reason and the command unchanged, so a
 * caller runs what the project configured either way and has one place to read
 * why the run will leave no trace.
 */
export function amendForTrace(
  command: string,
  outputDir: string,
): { command: string; skip?: string } {
  if (!PLAYWRIGHT_TEST.test(command)) {
    return {
      command,
      skip:
        "ccqa reads a spec's step screenshots out of the run's Playwright trace, and can only ask " +
        "for one when the target's runCommand invokes `playwright test` itself (e.g. `pnpm exec " +
        "playwright test {files}`)",
    };
  }
  if (SHELL_OPERATORS.test(command)) {
    return {
      command,
      skip:
        "the target's runCommand uses shell operators, so ccqa cannot safely append the " +
        "`--trace`/`--output` flags its step screenshots are read from",
    };
  }
  const directsOutput = /(^|\s)--output[=\s]/.test(command);
  if (directsOutput && !command.includes(outputDir)) {
    return {
      command,
      skip:
        "the target's runCommand passes its own --output, so ccqa cannot find the trace its step " +
        "screenshots are read from — point that flag at `{artifactsDir}` or drop it",
    };
  }
  const flags = [
    /(^|\s)--trace[=\s]/.test(command) ? "" : "--trace=on",
    directsOutput ? "" : `--output=${quoteForShell(outputDir)}`,
  ].filter(Boolean);
  return { command: flags.length > 0 ? `${command} ${flags.join(" ")}` : command };
}

/** Rendering one archive stops here, so a slow viewer cannot stall the report. */
const ARCHIVE_BUDGET_MS = 60_000;

/**
 * Make sure `evidenceDir` holds the spec's per-step screenshots, rendering them
 * from the trace the run left in `artifactsDir` when nothing else wrote them.
 * Returns null when the directory has evidence in it, and otherwise the reason
 * there is nothing to show. A step that gets no picture is reported through
 * `warn` and costs only its own row.
 *
 * A spec generated before the capture calls left the committed file writes its
 * own screenshots as it runs; those are the test's own and are left alone.
 */
export async function captureStepEvidence(args: {
  artifactsDir: string;
  evidenceDir: string;
  /** Where to resolve the project's Playwright from, nearest first; its trace viewer renders. */
  playwrightFrom: readonly string[];
  warn: (message: string) => void;
  openRenderer?: (dirs: readonly string[], archive: string) => Promise<SnapshotRenderer>;
}): Promise<string | null> {
  if ((await readdir(args.evidenceDir).catch(() => [])).length > 0) return null;
  const archives = lastAttempts((await walkFiles(args.artifactsDir)).filter(isTraceArchive)).map(
    (rel) => join(args.artifactsDir, ...rel.split("/")),
  );
  if (archives.length === 0) {
    return (
      "the run left no Playwright trace, so there are no per-step screenshots to read — the " +
      "generated test's `test.step` blocks are what ccqa reads them from"
    );
  }
  let written = 0;
  let named = 0;
  let firstError: string | undefined;
  for (const archive of archives) {
    try {
      const archived = await writeArchiveEvidence(archive, args);
      written += archived.written;
      named += archived.named;
      firstError ??= archived.firstError;
    } catch (err) {
      firstError ??= errMessage(err);
    }
  }
  if (written > 0) return null;
  if (firstError !== undefined) return `ccqa could not render the trace's snapshots: ${firstError}`;
  if (named === 0) {
    return (
      "the run's Playwright trace holds no step the case names — a rewrite pass may have reshaped " +
      "the `test.step` titles the draft wrote; re-run `ccqa generate` for this spec"
    );
  }
  return (
    "the run's Playwright trace holds no DOM snapshot for any step — Playwright records them only " +
    "while the trace's `snapshots` option is on (`--trace=on` asks for it; a `trace` option in " +
    "the project's config can turn it off)"
  );
}

/**
 * Each test's last attempt: a retry leaves `<dir>-retry<n>` beside the first
 * attempt's `<dir>`, and the attempt the row reports is the last one.
 */
export function lastAttempts(archives: readonly string[]): string[] {
  const last = new Map<string, { archive: string; attempt: number }>();
  for (const archive of archives) {
    const match = /^(.*)-retry(\d+)$/.exec(dirname(archive));
    const test = match ? match[1]! : dirname(archive);
    const attempt = match ? Number(match[2]) : 0;
    if ((last.get(test)?.attempt ?? -1) < attempt) last.set(test, { archive, attempt });
  }
  return [...last.values()].map((v) => v.archive).sort();
}

/** One archive's steps, written as evidence; how many steps the case named; the first render error. */
async function writeArchiveEvidence(
  archive: string,
  args: Parameters<typeof captureStepEvidence>[0],
): Promise<{ written: number; named: number; firstError?: string }> {
  const steps = parseTraceSteps(await readTraceJsonl(archive)).flatMap((step) => {
    const label = parseStepLabel(step.title);
    return label === null ? [] : [{ ...step, label }];
  });
  if (!steps.some((step) => step.after !== undefined)) return { written: 0, named: steps.length };

  const renderer = await (args.openRenderer ?? openSnapshotRenderer)(args.playwrightFrom, archive);
  const deadline = Date.now() + ARCHIVE_BUDGET_MS;
  let written = 0;
  let firstError: string | undefined;
  const render = async (snapshot: SnapshotRef, stepId: string, end: "before" | "after") => {
    let failure: string;
    try {
      const image = await renderer.render(snapshot);
      // A test's first step starts on the page's blank initial document.
      if (image !== null || end === "before") return image;
      failure = "snapshot rendered blank";
    } catch (err) {
      failure = errMessage(err);
    }
    firstError ??= failure;
    args.warn(`${stepId}: no ${end} screenshot — rendering ${snapshot.name} failed (${failure})`);
    return null;
  };
  try {
    await mkdir(args.evidenceDir, { recursive: true });
    for (const [index, step] of steps.entries()) {
      if (Date.now() > deadline) {
        args.warn(
          `stopped rendering after ${ARCHIVE_BUDGET_MS / 1000}s — ${steps.length - index} step(s) ` +
            "left without screenshots",
        );
        break;
      }
      const { stepId, source } = step.label;
      if (step.after === undefined) {
        args.warn(`${stepId}: no screenshot — the trace holds no DOM snapshot of a browser call in this step`);
        continue;
      }
      // The same stem the other evidence producers name their pair with.
      const stem = sanitizeStepId(stepId);
      const after = await render(step.after, stepId, "after");
      if (after === null) continue;
      await writeFile(join(args.evidenceDir, `${stem}.jpeg`), after);
      const before = step.before ? await render(step.before, stepId, "before") : null;
      if (before !== null) await writeFile(join(args.evidenceDir, `${stem}.before.jpeg`), before);
      await writeFile(
        join(args.evidenceDir, `${stem}.json`),
        `${JSON.stringify(
          {
            stepId,
            source,
            pngFile: `${stem}.jpeg`,
            ...(before !== null ? { beforePngFile: `${stem}.before.jpeg` } : {}),
            ...(step.error !== undefined ? { failureSummary: step.error } : {}),
            url: null,
            title: null,
            capturedAt: new Date().toISOString(),
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      written += 1;
    }
  } finally {
    await renderer.close().catch((err) => args.warn(`could not close the trace viewer (${errMessage(err)})`));
  }
  return { written, named: steps.length, ...(firstError !== undefined ? { firstError } : {}) };
}
