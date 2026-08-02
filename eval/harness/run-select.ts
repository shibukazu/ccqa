// Entry for `pnpm eval:select`. The library half lives in select-eval.ts so
// the wiring test can import it without tripping this CLI.

import { runEvalCli } from "./eval-runner.ts";
import { runSelectEval } from "./select-eval.ts";

await runEvalCli(
  "eval:select",
  "Evaluate `ccqa select-specs`: diff each case's two commits in a checkout of eval/app and score the verdicts against eval/cases.",
  runSelectEval,
);
