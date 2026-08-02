// Entry for `pnpm eval:audit`. The library half lives in audit-eval.ts so
// the wiring test can import it without tripping this CLI.

import { Command } from "commander";
import { runAuditEval } from "./audit-eval.ts";

const program = new Command("eval:audit")
  .description(
    "Evaluate `ccqa audit`: run the real command over mutated checkouts of eval/app and score the verdicts against eval/cases.",
  )
  .argument("[filter]", "Only run cases whose name contains this substring.")
  .option("-m, --model <name>", "Claude model alias ('sonnet'|'opus'|'haiku') or full ID.", "haiku")
  .action(async (filter: string | undefined, opts: { model: string }) => {
    await runAuditEval({ model: opts.model, ...(filter ? { filter } : {}) });
  });

try {
  await program.parseAsync();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
