import { AGENT_BROWSER_TARGET } from "../../spec/yaml-schema.ts";
import { getTestScript } from "../../store/index.ts";
import type { TargetPlugin } from "../types.ts";
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
  // generate regenerates test.spec.ts from ir.json, so a hand-edited script
  // would be silently lost — surface it for the CLI's overwrite guard.
  existingOutput: (ref, cwd) => getTestScript(ref.featureName, ref.specName, cwd),
  // No `runner`: the run pipeline special-cases this target and executes its
  // specs through the dedicated det (vitest) / live paths in
  // src/run/pipeline.ts, which own evidence capture, incremental live
  // reporting, and the mode-scoped CLI flags. Wrapping those in a TestRunner
  // would only add an adapter with a single caller — see
  // src/run/target-dispatch.ts, which routes agent-browser specs there.
};
