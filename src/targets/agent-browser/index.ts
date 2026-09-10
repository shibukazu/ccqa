import { AGENT_BROWSER_JUDGE_STEPS } from "./judge-steps.ts";
import { AGENT_BROWSER_TARGET } from "../../spec/yaml-schema.ts";
import { SPEC_DIR_TEMPLATE, TEST_SCRIPT_FILE } from "../../store/index.ts";
import type { TargetPlugin } from "../types.ts";
import { acquireAgentBrowserEndpoint } from "./browser-endpoint.ts";
import { generateAgentBrowserTest } from "./generate.ts";

/**
 * The built-in recorder-backed target: `ccqa record` traces the spec into
 * ir.json, and generate compiles that recording into a vitest + agent-browser
 * `test.spec.ts` (with the cleanup / auto-fix pipeline in generate.ts).
 */
export const agentBrowserTarget: TargetPlugin = {
  id: AGENT_BROWSER_TARGET,
  input: "recording",
  generate: generateAgentBrowserTest,
  // Spelled from the store's own layout constants, because this target's test
  // is written and enumerated by the store (`saveTestScript`, `listAllSpecs`)
  // rather than through `ctx.testPath`. Config may not override it — see the
  // refusal in src/config/project-config.ts — so the two agree by sharing
  // these constants.
  defaultTestPath: `${SPEC_DIR_TEMPLATE}/${TEST_SCRIPT_FILE}`,
  // No `runner`: the run pipeline special-cases this target and executes its
  // specs through the dedicated det (vitest) / live paths in
  // src/run/pipeline.ts, which own evidence capture, incremental live
  // reporting, and the mode-scoped CLI flags. Wrapping those in a TestRunner
  // would only add an adapter with a single caller — see
  // src/run/target-dispatch.ts, which routes agent-browser specs there.
  //
  // The live path supplies `driverSession`; the det (vitest replay) path does
  // not attach the engine yet — its replay creates the session inside the
  // child process, out of the parent's sight.
  browserCoverage: { browser: "cdp", cdpEndpoint: acquireAgentBrowserEndpoint },
  judgeSteps: AGENT_BROWSER_JUDGE_STEPS,
};
