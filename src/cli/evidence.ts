import { Command } from "commander";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { withUsageErrors } from "./usage-errors.ts";
import { RunUsageError } from "../run/errors.ts";
import { loadProjectConfig } from "../config/project-config.ts";
import { getRecording, readSpecReview } from "../store/index.ts";
import { resolveCase } from "./resolve-case.ts";
import { renderEvidence, sourceNeedles } from "../evidence/table.ts";
import { findSourceAnchors, type SourceAnchors } from "../evidence/source-anchors.ts";
import { resolveSourceRoots } from "../config/source-roots.ts";
import { loadEvidenceForSpec, specEvidenceDir } from "../report/evidence.ts";
import { DEFAULT_REPORT_DIR } from "../run/report-constants.ts";
import { addLanguageOption } from "./options.ts";
import { resolveCwd } from "./resolve-cwd.ts";
import * as log from "./logger.ts";

/**
 * `ccqa evidence <case>` — what a reviewer reads instead of the generated test.
 *
 * A fragment, deliberately: ccqa writes the table and stops. Assembling a pull
 * request out of it — which template, which sections, which repository — is
 * the consumer's, and a tool that wrote the whole body would be guessing at a
 * convention it cannot see.
 */
/**
 * The step screenshots the last run left, as links from wherever the table is
 * written. Read out of the run's own report rather than a place of this
 * command's own: they are written there by every path that captures them, and
 * a second convention would mean a table with no pictures next to a report
 * full of them.
 */
async function stepScreenshots(
  cwd: string,
  reportDirOption: string | undefined,
  caseId: string,
  relativeTo: string,
): Promise<Map<string, string[]>> {
  const reportDir = resolve(cwd, reportDirOption ?? DEFAULT_REPORT_DIR);
  const parts = caseId.split("/");
  const spec = parts.pop()!;
  const feature = parts.join("/") || spec;
  const evidence = await loadEvidenceForSpec(
    specEvidenceDir(reportDir, feature, spec),
    reportDir,
    new Map(),
  );
  const byStep = new Map<string, string[]>();
  for (const entry of evidence ?? []) {
    const paths = [entry.beforePngPath, entry.pngPath]
      .filter((p): p is string => typeof p === "string" && p.length > 0)
      .map((p) => relative(relativeTo, resolve(reportDir, p)) || p);
    if (paths.length > 0) byStep.set(entry.stepId, paths);
  }
  return byStep;
}

export const evidenceCommand = addLanguageOption(
  new Command("evidence")
    .argument("<case>", "Case id, or the path of its source file")
    .description(
      "Write the review table for a case: each step of the case against what was recorded, " +
        "what the generated test decides, and the screenshots of it happening.",
    )
    .option(
      "-o, --out <file>",
      "Where to write the table. Defaults to evidence.md in the case's own directory.",
    )
    .option(
      "--target <id>",
      "Read the case through this target instead of the project's default.",
    )
    .option(
      "--report-dir <dir>",
      `Run report to take the step screenshots from. Default: ${DEFAULT_REPORT_DIR}/`,
    )
    .option(
      "--cwd <path>",
      "Working directory containing the .ccqa/ tree (monorepo support). Defaults to the current directory.",
    ),
).action(
  withUsageErrors(
    async (
      caseArgument: string,
      opts: { out?: string; target?: string; reportDir?: string; cwd?: string },
    ) => {
      const cwd = resolveCwd(opts.cwd);
      const config = await loadProjectConfig(cwd);
      const resolved = await resolveCase(caseArgument, config, cwd, {
        ...(opts.target ? { targetOverride: opts.target } : {}),
      });
      const { testCase, testPath } = resolved;

      const recording = await getRecording(testCase.ref);
      const testAbs = resolve(cwd, testPath);
      const source = await readFile(testAbs, "utf8").catch(() => {
        throw new RunUsageError(
          `no generated test at ${testPath} — run 'ccqa generate ${testCase.ref.id}' first`,
        );
      });

      // What the last generation's review found, if one was obtained. Absent
      // is not "clean": the table says which it is.
      const review = (await readSpecReview(testCase.ref)) as
        | { warnings?: unknown; findings?: unknown }
        | null;
      const unchecked =
        review && Array.isArray(review.findings) && Array.isArray(review.warnings)
          ? (review.warnings as string[])
          : undefined;

      // Absent (not empty) `anchors` is what keeps the table's shape for a
      // project with no `sourceRoots` unchanged — see EvidenceInput.
      let anchors: SourceAnchors | undefined;
      if (config.sourceRoots.length > 0) {
        const roots = await resolveSourceRoots(cwd, config.sourceRoots).catch((e: unknown) => {
          throw new RunUsageError(e instanceof Error ? e.message : String(e));
        });
        const needles = sourceNeedles([...recording.actions, ...(recording.cleanup ?? [])]);
        anchors = await findSourceAnchors(needles, roots);
      }

      const out = resolve(cwd, opts.out ?? join(testCase.ref.dir, "evidence.md"));
      const markdown = renderEvidence({
        testCase,
        recording,
        test: { path: testPath, source },
        screenshots: await stepScreenshots(cwd, opts.reportDir, testCase.ref.id, dirname(out)),
        ...(unchecked ? { unchecked } : {}),
        ...(anchors ? { anchors } : {}),
      });
      await writeFile(out, markdown, "utf8");
      // Only the path on stdout: this is a file another tool picks up.
      process.stdout.write(`${relative(cwd, out) || out}\n`);
      log.hint("paste it into the pull request, or attach it — ccqa writes the table, not the body");
    },
  ),
);
