import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { parseStepLabel } from "../../codegen/step-comment.ts";
import { sanitizeStepId } from "../../runtime/evidence-constants.ts";
import { isTraceArchive, quoteForShell, walkFiles } from "../run-artifacts.ts";
import { frameAt, parseTraceEvents, readZip, type ZipArchive } from "./trace-evidence.ts";

/**
 * Per-step screenshots for a Playwright test that contains nothing of ccqa's.
 *
 * The test a project commits is plain `@playwright/test`: its steps are
 * `test.step` blocks and there is no capture call to place a screenshot at
 * either boundary. So the screenshots are not taken during the run at all —
 * ccqa asks Playwright for a trace on the invocations it owns, and afterwards
 * reads the step boundaries and the screencast out of the archive. Nothing in
 * the consumer's repository changes, and nothing ccqa does here can turn a
 * passing test red: the whole path runs after the command has exited, and a
 * trace it cannot read costs the report its pictures and says so.
 *
 * The frames are the trace's own screencast, which Playwright records
 * downscaled — they are the filmstrip a reviewer already sees in the trace
 * viewer, not `page.screenshot()` output. That is the price of taking the
 * capture code out of the committed file.
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

/**
 * Make sure `evidenceDir` holds the spec's per-step screenshots, reading the
 * trace the run left in `artifactsDir` when nothing else wrote them. Returns
 * null when the directory has evidence in it, and otherwise the reason there
 * is nothing to show.
 *
 * A spec generated before the capture calls left the committed file writes its
 * own frames as it runs; those are the test's own and are left alone.
 *
 * Every step of every trace found is written, not just the first archive's: a
 * retried test leaves one archive per attempt, and the later one overwrites
 * the earlier, which is the attempt the row reports.
 */
export async function captureStepEvidence(args: {
  artifactsDir: string;
  evidenceDir: string;
}): Promise<string | null> {
  if ((await readdir(args.evidenceDir).catch(() => [])).length > 0) return null;
  const archives = (await walkFiles(args.artifactsDir))
    .filter(isTraceArchive)
    .sort()
    .map((rel) => join(args.artifactsDir, ...rel.split("/")));
  if (archives.length === 0) {
    return (
      "the run left no Playwright trace, so there are no per-step screenshots to read — the " +
      "generated test's `test.step` blocks are what ccqa reads them from"
    );
  }
  let written = 0;
  let frames = 0;
  const failures: string[] = [];
  for (const archive of archives) {
    try {
      const archived = await writeArchiveEvidence(archive, args.evidenceDir);
      written += archived.written;
      frames += archived.frames;
    } catch (err) {
      failures.push(`${archive}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (written > 0) return null;
  if (failures.length > 0) return `ccqa could not read the run's Playwright trace (${failures[0]})`;
  // Two different problems, and the wrong one sends a reader to re-record a
  // spec whose titles were never touched.
  if (frames === 0) {
    return (
      "the run's Playwright trace holds no screenshots — the step frames come from its screencast, " +
      "which Playwright records only while the trace's `screenshots` option is on (`--trace=on` " +
      "asks for it; a `trace` option in the project's config can turn it off)"
    );
  }
  return (
    "the run's Playwright trace holds no step the case names — a rewrite pass may have reshaped " +
    "the `test.step` titles the draft wrote; re-run `ccqa generate` for this spec"
  );
}

/** One archive's steps, written as evidence, and the frames it had to write them from. */
async function writeArchiveEvidence(
  archive: string,
  evidenceDir: string,
): Promise<{ written: number; frames: number }> {
  const entries = await readZip(archive);
  // Every `.trace` member at once: the screencast and the steps are recorded
  // into separate files by some versions, and the frames are chosen by
  // timestamp rather than by position, so merging them cannot misorder.
  const jsonl = entries.names
    .filter((name) => name.endsWith(".trace"))
    .map((name) => entries.read(name)?.toString("utf8") ?? "")
    .join("\n");
  const { frames, steps } = parseTraceEvents(jsonl);
  if (frames.length === 0) return { written: 0, frames: 0 };
  await mkdir(evidenceDir, { recursive: true });
  let written = 0;
  for (const step of steps) {
    const label = parseStepLabel(step.title);
    if (label === null) continue;
    // The same stem the other evidence producers name their pair with.
    const stem = sanitizeStepId(label.stepId);
    // The closing frame first: it is the step's own screenshot, and without it
    // there is no meta to write — an entry frame taken ahead of it would be
    // left in the directory with nothing naming it.
    const after = await writeFrame(entries, frames, step.endTime, evidenceDir, stem);
    if (after === null) continue;
    const before = await writeFrame(entries, frames, step.startTime, evidenceDir, `${stem}.before`);
    await writeFile(
      join(evidenceDir, `${stem}.json`),
      `${JSON.stringify(
        {
          stepId: label.stepId,
          source: label.source,
          pngFile: after,
          ...(before !== null ? { beforePngFile: before } : {}),
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
  return { written, frames: frames.length };
}

/** The frame on screen at `time`, written under `stem`. Null when there is none. */
async function writeFrame(
  entries: ZipArchive,
  frames: Parameters<typeof frameAt>[0],
  time: number,
  evidenceDir: string,
  stem: string,
): Promise<string | null> {
  const frame = frameAt(frames, time);
  if (frame === null) return null;
  // The screencast is JPEG, and which of the two names the archive uses for a
  // resource has varied; the evidence loader reads the name out of the meta
  // rather than assuming one, so either is fine to write.
  const data =
    entries.read(`resources/${frame.sha1}`) ?? entries.read(`resources/${frame.sha1}.jpeg`);
  if (data === undefined) return null;
  const file = `${stem}.jpeg`;
  await writeFile(join(evidenceDir, file), data);
  return file;
}
