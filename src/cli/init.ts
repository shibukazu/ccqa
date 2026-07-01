import { Command } from "commander";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as log from "./logger.ts";
import { resolveCwd } from "./resolve-cwd.ts";

interface PromptTemplate {
  relPath: string;
  content: string;
}

const TEMPLATES: PromptTemplate[] = [
  {
    relPath: ".ccqa/prompts/live.user.md",
    content: `# Project guidance for live specs

Write stable, hand-maintained context here: staging URLs, naming conventions, known "this is fine" warnings. Lines you add will be appended verbatim to the system prompt of every step in 'mode: live' specs.
`,
  },
  {
    relPath: ".ccqa/prompts/live.agent.md",
    content: `# Agent learnings for live specs

This file is updated by 'ccqa run --update-agent-prompt'. You can edit it by hand, but the next --update-agent-prompt run may rewrite the whole file. Keep stable rules in live.user.md instead.
`,
  },
  {
    relPath: ".ccqa/prompts/record.user.md",
    content: `# Project guidance for ccqa record (deterministic trace)

Write stable, hand-maintained context here for the trace phase of 'ccqa record'. Lines you add will be appended verbatim to the trace system prompt.
`,
  },
  {
    relPath: ".ccqa/prompts/record.agent.md",
    content: `# Agent learnings for ccqa record

This file is updated by 'ccqa record --update-agent-prompt'. Same convention as live.agent.md — stable rules go in record.user.md.
`,
  },
  {
    // Saved sessions hold live auth cookies — never commit them. This self-
    // ignoring .gitignore keeps the whole directory out of git while staying
    // tracked itself, so `ccqa session bootstrap` has a safe place to write.
    relPath: ".ccqa/sessions/.gitignore",
    content: `# Saved browser sessions contain live auth cookies. Never commit them.
*
!.gitignore
`,
  },
];

interface InitOptions {
  cwd?: string;
  force?: boolean;
}

export const initCommand = new Command("init")
  .description(
    "Create .ccqa/prompts/{live,record}.{user,agent}.md template files (skips existing files unless --force).",
  )
  .option("--cwd <path>", "Working directory (default: cwd)")
  .option("--force", "Overwrite existing files")
  .action(async (opts: InitOptions) => {
    const cwd = resolveCwd(opts.cwd);
    log.header("init", cwd);

    await mkdir(join(cwd, ".ccqa", "prompts"), { recursive: true });
    await mkdir(join(cwd, ".ccqa", "sessions"), { recursive: true });

    const created: string[] = [];
    const skipped: string[] = [];
    for (const t of TEMPLATES) {
      const absPath = join(cwd, t.relPath);
      const written = await writeTemplate(absPath, t.content, opts.force ?? false);
      if (written) {
        created.push(t.relPath);
      } else {
        skipped.push(t.relPath);
      }
    }

    for (const f of created) log.info(`created  ${f}`);
    for (const f of skipped) log.info(`skipped  ${f} (already exists; pass --force to overwrite)`);
    log.blank();
    log.meta("created", created.length);
    log.meta("skipped", skipped.length);
  });

// `wx` preserves existing files so hand-written guidance is never clobbered;
// `--force` opts into overwrite. EEXIST is the "skip" signal, not an error.
async function writeTemplate(
  absPath: string,
  content: string,
  force: boolean,
): Promise<boolean> {
  try {
    await writeFile(absPath, content, force ? { encoding: "utf-8" } : { encoding: "utf-8", flag: "wx" });
    return true;
  } catch (err) {
    if (
      typeof err === "object" &&
      err !== null &&
      (err as { code?: string }).code === "EEXIST"
    ) {
      return false;
    }
    throw err;
  }
}
