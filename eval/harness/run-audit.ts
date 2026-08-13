// Entry for `pnpm eval:audit`. The library half lives in audit-eval.ts so
// the wiring test can import it without tripping this CLI.

import { runAuditEval } from "./audit-eval.ts";
import { runEvalCli } from "./eval-runner.ts";

await runEvalCli(
  "eval:audit",
  "Evaluate `ccqa audit`: run the real command over mutated checkouts of eval/app and score the verdicts against eval/cases.",
  runAuditEval,
);
