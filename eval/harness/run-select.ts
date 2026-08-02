// Entry for `pnpm eval:select`. The library half lives in select-eval.ts so
// the wiring test can import it without tripping this CLI.

import { Command } from "commander";
import { runSelectEval } from "./select-eval.ts";

const program = new Command("eval:select")
  .description(
    "Evaluate `ccqa select-specs`: diff each case's two commits in a checkout of eval/app and score the verdicts against eval/cases.",
  )
  .argument("[filter]", "Only run cases whose name contains this substring.")
  .option("-m, --model <name>", "Claude model alias ('sonnet'|'opus'|'haiku') or full ID.", "haiku")
  .action(async (filter: string | undefined, opts: { model: string }) => {
    await runSelectEval({ model: opts.model, ...(filter ? { filter } : {}) });
  });

try {
  await program.parseAsync();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
