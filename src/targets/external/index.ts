import { compileRecording } from "../playwright/index.ts";
import { acquirePlaywrightBrowser } from "../playwright/browser-server.ts";
import { runCommandRunner } from "../run-command-runner.ts";
import type { TargetConfig } from "../../config/project-config.ts";
import type { TargetPlugin } from "../types.ts";

/**
 * A target the project defines, not one ccqa ships.
 *
 * Everything that makes one repository's tests look like that repository's
 * tests — where a test file goes, which assets it may import, which
 * directories new ones may be created in, what the file's header says, how a
 * unique value is named, which command checks the result — is configuration
 * (`kind: external` in `.ccqa/config.yaml`). ccqa contributes the mechanisms,
 * and nothing here is a second implementation of them: the code this target
 * generates comes out of the same pipeline the built-in `playwright` target
 * uses, so a gate that guards one guards the other.
 *
 * `framework` exists so a project states which framework its tests are written
 * for rather than inheriting it silently. Today `playwright` is the only value
 * the config accepts, and any other is refused when the config loads.
 */
export function createExternalTarget(id: string, config: TargetConfig): TargetPlugin {
  return {
    id,
    input: "recording",
    generate: (ctx) => compileRecording(ctx, "playwright"),
    // No default: a target with no code of its own has no opinion about where
    // the project keeps its tests, so `testPath` is required in its config.
    defaultTestPath: config.testPath ?? "",
    runner: runCommandRunner,
    stepEvidence: config.hooks.stepEvidence
      ? { supported: true }
      : {
          supported: false,
          reason: `the "${id}" target has step evidence turned off in .ccqa/config.yaml`,
        },
    judgeSteps: { supported: true },
    browserCoverage: { browser: "cdp", cdpEndpoint: acquirePlaywrightBrowser },
    // Learned generation guidance is keyed by the prompt kind, and this
    // target's generation is the playwright one — a project that refines that
    // playbook refines it for both.
    guidanceKind: "playwright",
  };
}
