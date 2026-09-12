import { Command } from "commander";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { withUsageErrors } from "./usage-errors.ts";
import { RunUsageError } from "../run/errors.ts";
import { loadProjectConfig } from "../config/project-config.ts";
import { resolveLanguage } from "../prompts/language.ts";
import { getRecording, keptCaseRun, readSpecReview, splitCaseId } from "../store/index.ts";
import type { TestCase } from "../intent/case.ts";
import { resolveCase } from "./resolve-case.ts";
import { renderEvidence, sourceNeedles } from "../evidence/table.ts";
import { findSourceAnchors, type SourceAnchors } from "../evidence/source-anchors.ts";
import { resolveSourceRoots } from "../config/source-roots.ts";
import { loadEvidenceForSpec, specEvidenceDir } from "../report/evidence.ts";
import { DEFAULT_REPORT_DIR } from "../run/report-constants.ts";
import { addLanguageOption } from "./options.ts";
import { resolveCwd } from "./resolve-cwd.ts";
import { loadEnvFiles } from "./env-files.ts";
import type { SpecCoverageFinding } from "../targets/verifies-spec.ts";
import { buildProseEnvScrubMap, scrubEnvValues } from "../runtime/env-scrub.ts";
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
 * The step screenshots to link from wherever the table is written.
 *
 * A run's own report first: every path that captures them writes there, and a
 * second convention would mean a table with no pictures next to a report full
 * of them. When there is no such report — a project whose generated tests
 * belong to its own runner never calls `ccqa run` — the ones the generation's
 * verification took stand in. They are the same file pair, taken of the same
 * test passing.
 */
async function stepScreenshots(
  cwd: string,
  reportDirOption: string | undefined,
  testCase: TestCase,
  relativeTo: string,
): Promise<Map<string, string[]>> {
  const reportDir = resolve(cwd, reportDirOption ?? DEFAULT_REPORT_DIR);
  const { featureName, specName } = splitCaseId(testCase.ref.id);
  const fromRun = await linkEvidence(
    specEvidenceDir(reportDir, featureName, specName),
    reportDir,
    relativeTo,
  );
  if (fromRun.size > 0) return fromRun;
  const generated = await keptCaseRun(testCase.ref);
  return generated === null ? fromRun : linkEvidence(generated, generated, relativeTo);
}

/** One evidence directory's captures, as paths relative to the table's own file. */
async function linkEvidence(
  evidenceDir: string,
  base: string,
  relativeTo: string,
): Promise<Map<string, string[]>> {
  const evidence = await loadEvidenceForSpec(evidenceDir, base, new Map());
  const byStep = new Map<string, string[]>();
  for (const entry of evidence ?? []) {
    const paths = [entry.beforePngPath, entry.pngPath]
      .filter((p): p is string => typeof p === "string" && p.length > 0)
      .map((p) => relative(relativeTo, resolve(base, p)) || p);
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
      opts: { out?: string; target?: string; reportDir?: string; cwd?: string; language?: string },
    ) => {
      const cwd = resolveCwd(opts.cwd);
      const config = await loadProjectConfig(cwd);
      // Loaded for the scrub below, not to resolve anything: without them
      // there is no map, and the scrub would quietly pass a credential
      // through into a table written to be pasted somewhere public.
      await loadEnvFiles(config.envFiles, cwd);
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
      const saved = (await readSpecReview(testCase.ref)) as
        | { findings?: unknown; complete?: unknown }
        | null;
      // A review whose model half could not be obtained still carries the
      // mechanical findings, and must not read as one that found nothing.
      const review =
        Array.isArray(saved?.findings) && saved.complete === true
          ? (saved.findings as SpecCoverageFinding[])
          : undefined;

      // Absent (not empty) `anchors` is what keeps the table's shape for a
      // project with no `sourceRoots` unchanged — see EvidenceInput.
      let anchors: SourceAnchors | undefined;
      if (config.sourceRoots.length > 0) {
        const roots = await resolveSourceRoots(cwd, config.sourceRoots);
        const needles = sourceNeedles([...recording.actions, ...(recording.cleanup ?? [])]);
        anchors = await findSourceAnchors(needles, roots);
      }

      const out = resolve(cwd, opts.out ?? join(testCase.ref.dir, "evidence.md"));
      const markdown = renderEvidence({
        testCase,
        recording,
        test: { path: testPath, source },
        screenshots: await stepScreenshots(cwd, opts.reportDir, testCase, dirname(out)),
        labels: config.evidence.labels,
        language: resolveLanguage(opts.language, config.language),
        // Only when the project forbade them: otherwise they were asserted,
        // and listing them as unchecked would be the table's own lie.
        ...(resolved.targetConfig.allowExpectInCleanup
          ? {}
          : { cleanupUnchecked: testCase.cleanupExpectations }),
        ...(review ? { review } : {}),
        ...(anchors ? { anchors } : {}),
      });
      // The last thing between a recording and a pull request. The route is
      // scrubbed when it is recorded, but a route recorded before this project
      // named its env files still holds the values — and this table is written
      // to be pasted somewhere public.
      await writeFile(out, scrubEnvValues(markdown, buildProseEnvScrubMap([], [])), "utf8");
      // Only the path on stdout: this is a file another tool picks up.
      process.stdout.write(`${relative(cwd, out) || out}\n`);
      log.hint("paste it into the pull request, or attach it — ccqa writes the table, not the body");
    },
  ),
);
