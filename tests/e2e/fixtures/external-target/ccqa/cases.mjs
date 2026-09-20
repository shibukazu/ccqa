import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

// How this project hands its test cases to ccqa. The headings below are this
// project's own; ccqa never sees them.

const ROOT = "docs/testcase";

/** @type {import("ccqa/case-source").CaseSourceFactory} */
export default function cases({ cwd }) {
  const root = resolve(cwd, ROOT);
  const fileFor = (id) => join(root, `${id}.md`);

  return {
    async list() {
      const files = await walk(root);
      return files.map((abs) => relative(root, abs).replace(/\.md$/, "")).sort();
    },

    async load(ref) {
      // Both spellings reach the same case: the path a person sees in their
      // editor, and the id everything else cites.
      const id = ref.startsWith(ROOT)
        ? relative(ROOT, ref).replace(/\.md$/, "")
        : ref.replace(/\.md$/, "");
      const path = fileFor(id);
      return read(id, path, await readFile(path, "utf8"));
    },
  };
}

/** Every `.md` below `dir`, recursively. */
async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const found = [];
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await walk(abs)));
    else if (entry.name.endsWith(".md")) found.push(abs);
  }
  return found;
}

/**
 * One document as a case.
 *
 * @returns {import("ccqa/case-source").Case}
 */
function read(id, path, text) {
  const sections = split(text);
  const body = (heading) => sections.get(heading) ?? "";
  const link = bullets(body("Link")).find((item) => item.startsWith("URL:"));
  return {
    id,
    path,
    text,
    title: firstLine(body("Title")) || id,
    mode: firstLine(body("Mode")).toLowerCase() === "live" ? "live" : "deterministic",
    steps: numbered(body("Steps")).map((instruction) => ({ instruction })),
    cleanup: numbered(body("Cleanup")).map((instruction) => ({ instruction })),
    expectations: bullets(body("Expected")),
    // What the teardown must make true, written under it as bullets.
    cleanupExpectations: bullets(body("Cleanup")),
    // Everything ccqa does not act on, passed through for the recorder to read.
    context: [...sections]
      .filter(([heading]) => !CLAIMED.has(heading))
      .map(([heading, sectionBody]) => ({ heading, body: sectionBody })),
    fields: {
      ...(firstLine(body("Priority")) ? { priority: firstLine(body("Priority")) } : {}),
      ...(link ? { "link.url": link.slice("URL:".length).trim() } : {}),
    },
  };
}

const CLAIMED = new Set(["Title", "Mode", "Steps", "Cleanup", "Expected", "Priority", "Link"]);

/** `## Heading` splits the document; deeper headings stay in their section. */
function split(text) {
  const sections = new Map();
  let heading = null;
  let lines = [];
  const flush = () => {
    if (heading !== null) sections.set(heading, lines.join("\n").trim());
  };
  for (const line of text.split(/\r?\n/)) {
    const match = /^##\s+(.*\S)\s*$/.exec(line);
    if (match) {
      flush();
      heading = match[1];
      lines = [];
    } else if (heading !== null) {
      lines.push(line);
    }
  }
  flush();
  return sections;
}

function numbered(body) {
  return body
    .split("\n")
    .map((line) => /^\s*\d+[.)]\s*(.+)$/.exec(line)?.[1]?.trim())
    .filter((text) => text !== undefined && text.length > 0);
}

function bullets(body) {
  return body
    .split("\n")
    .map((line) => /^\s*[-*]\s*(.+)$/.exec(line)?.[1]?.trim())
    .filter((text) => text !== undefined && text.length > 0);
}

function firstLine(body) {
  return body.split("\n")[0]?.trim() ?? "";
}
