import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

// How this project hands its test cases to ccqa. These cases carry a title, a
// numbered list of steps, what must then be true, and how they run; a project
// with more in its documents reads more here.

const ROOT = "docs/testcase";

/** @type {import("ccqa/case-source").CaseSourceFactory} */
export default function cases({ cwd }) {
  const root = resolve(cwd, ROOT);

  return {
    async list() {
      const names = await readdir(root, { recursive: true });
      return names.filter((name) => name.endsWith(".md")).map(toId);
    },

    async load(ref) {
      const id = toId(ref.startsWith(ROOT) ? relative(ROOT, ref) : ref);
      const path = join(root, `${id}.md`);
      const text = await readFile(path, "utf8");
      const section = (heading) => sectionOf(text, heading);
      return {
        id,
        path,
        text,
        title: firstLine(section("Title")) || id,
        mode: firstLine(section("Mode")).toLowerCase() === "live" ? "live" : "deterministic",
        steps: listItems(section("Steps"), /^\s*\d+[.)]\s*/).map((instruction) => ({ instruction })),
        expectations: listItems(section("Expected"), /^\s*[-*]\s*/),
      };
    },
  };
}

/** A path below the root, or an id already in that form, as an id. */
function toId(name) {
  return name.replace(/\.md$/, "").split(/[\\/]+/).join("/");
}

/** One `## Heading` section's body; deeper headings stay inside it. */
function sectionOf(text, heading) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start === -1) return "";
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^##\s/.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
}

/** Every line of `body` that starts with `marker`, with the marker removed. */
function listItems(body, marker) {
  return body
    .split("\n")
    .filter((line) => marker.test(line))
    .map((line) => line.replace(marker, "").trim())
    .filter(Boolean);
}

function firstLine(body) {
  return body.split("\n")[0]?.trim() ?? "";
}
