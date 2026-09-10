import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SourceRoot } from "../config/source-roots.ts";
import type { SpecArtifacts } from "./artifacts.ts";

/**
 * Everything one audit was given, written where a person can read it.
 *
 * The question this answers is not "was the verdict right" but the one before
 * it: did the thing I expected to be checked even reach the audit? A finding
 * that never appears has two very different causes — the file was not among
 * the inputs, or it was and the model said nothing about it — and from the
 * outside they look identical. Nothing else ccqa writes distinguishes them.
 *
 * One file per case, holding the prompts verbatim rather than a summary of
 * them: a summary would need its own decisions about what matters, and what
 * matters is exactly what is in dispute when someone reaches for this. The
 * document and the files are inside those prompts already; what is added
 * above them is which import reached each file, which the prompt never says.
 */
export interface AuditInputs {
  caseId: string;
  artifacts: SpecArtifacts;
  sourceRoots: readonly SourceRoot[];
  systemPrompt: string;
  userPrompt: string;
}

export function renderAuditInputs(input: AuditInputs): string {
  const { artifacts } = input;
  const lines = [
    `# Audit inputs — ${input.caseId}`,
    "",
    "What the audit of this case was given, verbatim. If something you expected",
    "it to check is not below, it never reached the audit.",
    "",
    "## Source roots",
    "",
    ...(input.sourceRoots.length > 0
      ? input.sourceRoots.map((r) => `- \`${r.configured}\` → \`${r.abs}\``)
      : ["None configured: the audit read the working directory only."]),
    "",
    "## Files handed over",
    "",
  ];
  if (artifacts.reached.length === 0) {
    lines.push(
      artifacts.live
        ? "None: a live case has no generated test — the document below is what runs."
        : "None: this case has no generated test yet.",
      "",
    );
  } else {
    const overBudget = new Set(artifacts.unaudited);
    lines.push("| File | Reached through | Read |", "|---|---|---|");
    for (const f of artifacts.reached) {
      const read = overBudget.has(f.path) ? "no — over the size budget" : "yes";
      lines.push(`| \`${cell(f.path)}\` | \`${cell(f.from)}\` | ${read} |`);
    }
    lines.push("");
  }

  // The document and every file handed over are already inside the user prompt
  // below, verbatim — printing them again would double the file to say the
  // same thing twice. What the table above adds is the one fact the prompt
  // does not carry: which import reached each file.
  lines.push("## System prompt", "", fence("", input.systemPrompt), "");
  lines.push("## User prompt", "", fence("", input.userPrompt), "");
  return lines.join("\n");
}

/** `<dir>/<case id>.md`, with the case's own path shape kept below `dir`. */
export async function writeAuditInputs(dir: string, input: AuditInputs): Promise<string> {
  const path = join(dir, `${input.caseId}.md`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, renderAuditInputs(input), "utf8");
  return path;
}

/** A path holding a `|` would otherwise end the table cell it sits in. */
function cell(text: string): string {
  return text.replaceAll("|", "\\|");
}

/**
 * A fence long enough to hold the content: prompts and generated code contain
 * fenced blocks of their own, and a three-backtick fence around them ends at
 * the first one — silently truncating the thing the file exists to show.
 */
function fence(lang: string, body: string): string {
  const longest = [...body.matchAll(/`{3,}/g)].reduce((n, m) => Math.max(n, m[0].length), 2);
  const ticks = "`".repeat(longest + 1);
  return `${ticks}${lang}\n${body}\n${ticks}`;
}
