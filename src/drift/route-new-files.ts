import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { invokeClaudeStreaming } from "../claude/invoke.ts";
import { extractJsonBlock } from "../claude/extract-json.ts";
import * as log from "../cli/logger.ts";

export interface SpecSummary {
  featureName: string;
  specName: string;
  relatedPaths: string[];
}

export interface RouteNewFilesInput {
  newFiles: string[];
  specs: SpecSummary[];
  cwd: string;
  model?: string;
}

/**
 * Lightweight Claude call: given a list of new files in the PR and the existing
 * specs (with their relatedPaths globs as a hint), return the spec keys (in
 * "<feature>/<spec>" form) that the new files plausibly affect.
 *
 * Conservative by design — false positives are safer than false negatives,
 * because a missed spec turns into undetected drift in CI. When the router
 * call itself fails, we log a warning rather than fail-close: the surrounding
 * glob match is the primary signal; the router only adds coverage for new
 * paths no glob captures.
 */
export async function routeNewFilesToSpecs(input: RouteNewFilesInput): Promise<Set<string>> {
  const { newFiles, specs, cwd, model } = input;
  const empty = new Set<string>();
  if (newFiles.length === 0 || specs.length === 0) return empty;

  const previews = await Promise.all(
    newFiles.map(async (path) => ({ path, head: await readHead(join(cwd, path)) })),
  );

  const { result, isError } = await invokeClaudeStreaming(
    {
      prompt: buildRouterPrompt(previews, specs),
      systemPrompt: buildRouterSystemPrompt(),
      allowedTools: ["Read", "Grep", "Glob"],
      silenceBashLog: true,
      cwd,
      ...(model ? { model } : {}),
    },
    (_msg: SDKMessage) => {},
  );

  if (isError) {
    log.warn("new-file router: Claude returned an error; skipping router signal");
    return empty;
  }
  const json = extractJsonBlock(result);
  if (!json) {
    log.warn("new-file router: no JSON block in response; skipping router signal");
    return empty;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    log.warn(`new-file router: failed to parse JSON (${(e as Error).message}); skipping router signal`);
    return empty;
  }

  const out = new Set<string>();
  const validKeys = new Set(specs.map((s) => `${s.featureName}/${s.specName}`));
  if (typeof parsed === "object" && parsed !== null && "affectedSpecs" in parsed) {
    const arr = (parsed as { affectedSpecs?: unknown }).affectedSpecs;
    if (Array.isArray(arr)) {
      for (const item of arr) {
        if (typeof item === "string" && validKeys.has(item)) out.add(item);
      }
    }
  }
  return out;
}

async function readHead(absPath: string): Promise<string> {
  const content = await readFile(absPath, "utf-8").catch(() => "");
  if (!content) return "";
  const lines = content.split("\n").slice(0, 40);
  return lines.join("\n");
}

export function buildRouterSystemPrompt(): string {
  return `You triage which ccqa test specs are potentially affected by NEW source files added in a pull request.

You will receive:
- A list of new files (path + first ~40 lines of each)
- A list of existing specs with their declared relatedPaths globs

Your job: return the spec keys (in "<feature>/<spec>" form) whose behaviour might depend on any of the new files.

## Rules

- Be **conservative**: when in doubt, include the spec. A spurious inclusion costs one extra drift check; a missed spec lets real drift slip through CI.
- Use \`Read\`, \`Grep\`, \`Glob\` if you need to inspect the spec body or related code, but stay focused — this is a triage step, not a full review.
- Ignore specs whose relatedPaths clearly point to a different area than every new file (e.g. \`src/auth/**\` specs vs new files only under \`src/billing/**\`).
- Files like tests, generated code, build artifacts, vendor dirs typically do not affect any spec. Skip them.

## Output (STRICT)

Output ONE fenced \`\`\`json block, nothing else:

\`\`\`json
{
  "affectedSpecs": ["feature/spec", "feature/spec"]
}
\`\`\`

Use exactly the keys you saw in the input ("<feature>/<spec>"). Return an empty array if no spec is affected.
`;
}

export function buildRouterPrompt(
  previews: Array<{ path: string; head: string }>,
  specs: SpecSummary[],
): string {
  const fileBlocks = previews
    .map((p) => {
      const headBlock = p.head ? `\n\`\`\`\n${p.head}\n\`\`\`` : "\n(empty or unreadable)";
      return `### ${p.path}${headBlock}`;
    })
    .join("\n\n");

  const specBlocks = specs
    .map((s) => {
      const paths = s.relatedPaths.length === 0
        ? "  (no relatedPaths declared)"
        : s.relatedPaths.map((p) => `  - ${p}`).join("\n");
      return `- ${s.featureName}/${s.specName}\n${paths}`;
    })
    .join("\n");

  return `## New files

${fileBlocks}

## Existing specs

${specBlocks}

## Task

Return the spec keys that might be affected by any of the new files. Conservative inclusion is preferred over missing real drift.
`;
}
