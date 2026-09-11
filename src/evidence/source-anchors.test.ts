import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findSourceAnchors, type SourceNeedle } from "./source-anchors.ts";
import type { SourceRoot } from "../config/source-roots.ts";

let cwd: string;

async function makeRoot(files: Record<string, string>): Promise<SourceRoot> {
  // realpath: on macOS the tmpdir lives behind a /var → /private/var symlink.
  cwd = await realpath(await mkdtemp(join(tmpdir(), "ccqa-source-anchors-")));
  for (const [path, contents] of Object.entries(files)) {
    const abs = join(cwd, path);
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, contents, "utf8");
  }
  return { configured: "src", abs: cwd };
}

const text = (value: string): SourceNeedle => ({ value, kind: "text" });
const testid = (value: string): SourceNeedle => ({ value, kind: "testid" });

afterEach(async () => {
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

describe("findSourceAnchors", () => {
  it("finds the file:line containing the needle as a substring", async () => {
    const root = await makeRoot({
      "components/Form.tsx": "export const Form = () => <button>Send</button>;",
    });
    const { found } = await findSourceAnchors([text("Send")], [root]);
    expect(found.get("Send")).toEqual({ needle: "Send", places: ["src/components/Form.tsx:1"] });
  });

  // The failure this ranking exists for: the string was in a design document
  // and in a seed script, and the walk reached those first.
  it("answers with the screen that renders the string, not the documents about it", async () => {
    const root = await makeRoot({
      "docs/design.html": "<p>The button reads Submit request</p>",
      "scripts/seed.ts": '// creates a "Submit request" button for the demo\nconst x = 1;',
      "ui/RequestForm.tsx": '<button>Submit request</button>',
    });
    const { found } = await findSourceAnchors([text("Submit request")], [root]);
    expect(found.get("Submit request")?.places).toEqual(["src/ui/RequestForm.tsx:1"]);
  });

  // A string only a comment mentions is not something the product renders, so
  // "not found" is the true answer rather than a line nobody will ever see.
  it("does not answer with a comment line", async () => {
    const root = await makeRoot({
      "ui/Panel.tsx": '// TODO: rename Save draft\nconst x = 1;',
      "ui/Other.tsx": '<span>{/* Save draft was here */}</span>',
      "lib/util.py": "# Save draft\nx = 1",
    });
    const { found } = await findSourceAnchors([text("Save draft")], [root]);
    expect(found.has("Save draft")).toBe(false);
  });

  it("prefers a UI file over other code, and other code over nothing", async () => {
    const root = await makeRoot({
      "lib/labels.ts": 'export const LABEL = "Archive";',
      "ui/Row.tsx": "<button>Archive</button>",
    });
    const { found } = await findSourceAnchors([text("Archive")], [root]);
    expect(found.get("Archive")?.places).toEqual(["src/ui/Row.tsx:1"]);
  });

  it("reads a translation catalogue, but only under a translations directory", async () => {
    const root = await makeRoot({
      "i18n/en.json": '{ "form.submit": "Send it" }',
      "data/other.json": '{ "unrelated": "Send it" }',
    });
    const { found } = await findSourceAnchors([text("Send it")], [root]);
    expect(found.get("Send it")?.places).toEqual(["src/i18n/en.json:1"]);
  });

  // Naming one of them would read as "this is where it comes from", which is
  // exactly the claim the scan cannot make.
  it("says so when several places say it equally well, and shows two", async () => {
    const root = await makeRoot({
      "ui/A.tsx": "<button>Retry</button>",
      "ui/B.tsx": "<button>Retry</button>",
      "ui/C.tsx": "<button>Retry</button>",
    });
    const { found } = await findSourceAnchors([text("Retry")], [root]);
    expect(found.get("Retry")).toEqual({
      needle: "Retry",
      places: ["src/ui/A.tsx:1", "src/ui/B.tsx:1"],
    });
  });

  // Ranking must not turn a lookup into a full-repo grep: once a needle has
  // the best rank in both the places the table shows, nothing else can change
  // its answer, so the third file is never opened.
  it("stops reading once every needle's answer can no longer change", async () => {
    const root = await makeRoot({
      "ui/A.tsx": "<button>Retry</button>",
      "ui/B.tsx": "<button>Retry</button>",
      "ui/C.tsx": "<button>Retry</button>",
    });
    // maxFiles 2 would leave a needle unsearched if the scan had to keep going.
    const { found, unsearched } = await findSourceAnchors([text("Retry")], [root], { maxFiles: 2 });
    expect(unsearched.size).toBe(0);
    expect(found.get("Retry")?.places).toEqual(["src/ui/A.tsx:1", "src/ui/B.tsx:1"]);
  });

  // A test id is declared once, as an attribute. Everything else naming it —
  // a selector in the application, a comment — is a use, not the declaration.
  it("matches a test id only where it is declared as an attribute", async () => {
    const root = await makeRoot({
      "ui/Uses.tsx": 'document.querySelector("[data-testid=submit-button]");',
      "ui/Declares.tsx": '<button data-testid="submit-button">Go</button>',
    });
    const { found } = await findSourceAnchors([testid("submit-button")], [root]);
    expect(found.get("submit-button")?.places).toEqual(["src/ui/Declares.tsx:1"]);
  });

  // Both files are UI source, so the file rank ties and the rendered one has
  // to win on how the string appears — otherwise a reviewer is handed the
  // error message that mentions the button instead of the button.
  it("prefers the line that renders the string over one that merely holds it", async () => {
    const root = await makeRoot({
      "ai/tools/showCreateButton.tsx": 'throw new Error("Add content is not available here");',
      "features/policies/PoliciesPage.tsx": "<Button>Add content</Button>",
    });
    const { found } = await findSourceAnchors([text("Add content")], [root]);
    expect(found.get("Add content")?.places).toEqual(["src/features/policies/PoliciesPage.tsx:1"]);
  });

  // A story sits beside the component it covers, so no path segment says what
  // it is — only the file name does.
  it("drops a story or a test by its file name, wherever it sits", async () => {
    const root = await makeRoot({
      "ui/Sidebar.stories.tsx": "<button>Category</button>",
      "ui/Sidebar.spec.tsx": "<button>Category</button>",
      "ui/Sidebar.tsx": "<button>Category</button>",
    });
    const { found } = await findSourceAnchors([text("Category")], [root]);
    expect(found.get("Category")?.places).toEqual(["src/ui/Sidebar.tsx:1"]);
  });

  it("skips node_modules, .git, dist, build, coverage, .next and dotted directories", async () => {
    // Nothing outside a skipped directory contains the needle, so it is only
    // found at all if the walker wrongly descends into one of them.
    const root = await makeRoot({
      "node_modules/dep/index.ts": 'const submit = "submit";',
      ".git/hooks/pre-commit.ts": 'const submit = "submit";',
      "dist/bundle.js": 'const submit = "submit";',
      "build/out.js": 'const submit = "submit";',
      "coverage/report.js": 'const submit = "submit";',
      ".next/cache.js": 'const submit = "submit";',
      ".hidden/file.ts": 'const submit = "submit";',
      "real.ts": "const other = 1;",
    });
    const { found } = await findSourceAnchors([text("submit")], [root]);
    expect(found.has("submit")).toBe(false);
  });

  it("only reads files with an allowlisted source extension", async () => {
    const root = await makeRoot({
      "notes.txt": 'const submit = "submit";',
      "styles.css": ".submit { color: red; }",
      "app.ts": 'const submit = "submit";',
    });
    const { found } = await findSourceAnchors([text("submit")], [root]);
    expect(found.get("submit")?.places).toEqual(["src/app.ts:1"]);
  });

  it("skips files larger than maxFileBytes", async () => {
    const root = await makeRoot({
      "big.ts": `const submit = "submit"; const pad = "${"x".repeat(100)}";`,
      "small.ts": 'const submit = "submit";',
    });
    const { found } = await findSourceAnchors([text("submit")], [root], { maxFileBytes: 50 });
    expect(found.get("submit")?.places).toEqual(["src/small.ts:1"]);
  });

  // A large first root used to spend the shared budget outright, so a string
  // that lives only in a later root came back as never searched.
  it("gives each configured root its own budget", async () => {
    const first = await mkdtemp(join(tmpdir(), "ccqa-anchors-a-"));
    const second = await mkdtemp(join(tmpdir(), "ccqa-anchors-b-"));
    await writeFile(join(first, "one.tsx"), `<button>Unrelated</button>`, "utf8");
    await writeFile(join(first, "two.tsx"), `<button>Also unrelated</button>`, "utf8");
    await writeFile(join(second, "late.tsx"), `<button>Publish</button>`, "utf8");

    const { found, unsearched } = await findSourceAnchors(
      [text("Publish")],
      [
        { configured: "../first", abs: first },
        { configured: "../second", abs: second },
      ],
      { maxFiles: 2 },
    );
    expect(unsearched.has("Publish")).toBe(false);
    expect(found.get("Publish")?.places[0]).toContain("late.tsx");

    await rm(first, { recursive: true, force: true });
    await rm(second, { recursive: true, force: true });
  });

  // docs/running.md promises the first root listed is the application you
  // mean. A sibling checkout that happens to render the string in nicer markup
  // must not take the citation away from it.
  it("keeps the earlier root's answer even when a later root has a better line", async () => {
    const first = await mkdtemp(join(tmpdir(), "ccqa-anchors-first-"));
    const second = await mkdtemp(join(tmpdir(), "ccqa-anchors-second-"));
    await writeFile(join(first, "app.tsx"), `const label = "Publish";`, "utf8");
    await writeFile(join(second, "stale.tsx"), `<button aria-label="Publish" />`, "utf8");

    const { found } = await findSourceAnchors(
      [text("Publish")],
      [
        { configured: "../first", abs: first },
        { configured: "../second", abs: second },
      ],
    );
    expect(found.get("Publish")?.places[0]).toContain("app.tsx");

    await rm(first, { recursive: true, force: true });
    await rm(second, { recursive: true, force: true });
  });

  it("stops after maxFiles files, leaving later needles unresolved", async () => {
    const root = await makeRoot({
      "a.ts": "const one = 1;",
      "b.ts": "const two = 2;",
      "c.ts": 'const submit = "submit";',
    });
    // Breadth-first, alphabetical within a level: a.ts, b.ts read; c.ts never opened.
    const { found, unsearched } = await findSourceAnchors([text("submit")], [root], { maxFiles: 2 });
    expect(found.has("submit")).toBe(false);
    // Stopping early is not a result: the reviewer must not read this as
    // "the product does not contain this string".
    expect(unsearched.has("submit")).toBe(true);
  });

  it("keeps an earlier root's answer rather than calling a later one ambiguous", async () => {
    const rootA = await makeRoot({ "a.ts": 'const submit = "submit";' });
    const cwdA = cwd;
    const rootB = await makeRoot({ "b.ts": 'const submit = "submit";' });
    try {
      const { found } = await findSourceAnchors(
        [text("submit")],
        [
          { configured: "root-a", abs: cwdA },
          { configured: "root-b", abs: rootB.abs },
        ],
      );
      expect(found.get("submit")).toEqual({ needle: "submit", places: ["root-a/a.ts:1"] });
    } finally {
      await rm(cwdA, { recursive: true, force: true });
    }
  });

  // The observed failure: a label's text also appears in the constant that
  // defines it and in the analytics event that fires with it, and those come
  // first in the file — so the citation pointed at a line nobody renders.
  it("cites where the string is rendered, not the first line that contains it", async () => {
    const root = await makeRoot({
      "ui/Page.tsx": [
        `const analyticsEvent = "Send it clicked";`,
        `export function Page() {`,
        `  return <button aria-label="Send it">Send it</button>;`,
        `}`,
      ].join("\n"),
    });
    const { found } = await findSourceAnchors([text("Send it")], [root]);
    expect(found.get("Send it")?.places).toEqual(["src/ui/Page.tsx:3"]);
    expect(found.get("Send it")?.partial).toBeUndefined();
  });

  // `name` and `title` are the commonest keys in a table of navigation
  // entries, and reading one as the strongest evidence sends the citation to
  // the constant that defines a label instead of the markup that renders it.
  it("does not read an object key as a rendered attribute", async () => {
    const root = await makeRoot({
      "ui/Nav.tsx": [
        `const NAV = [{ name: "Settings", path: "/settings" }];`,
        `export const Nav = () => <a aria-label="Settings">Settings</a>;`,
      ].join("\n"),
    });
    const { found } = await findSourceAnchors([text("Settings")], [root]);
    expect(found.get("Settings")?.places).toEqual(["src/ui/Nav.tsx:2"]);
  });

  // Whatever a citation names, that line has to hold the string it cites.
  it("cites a line that contains the string, through CRLF and multi-byte text", async () => {
    const root = await makeRoot({
      "ui/Crlf.tsx": "a\r\nb\r\nc\r\n<button>Send it</button>\r\n",
      "ui/Wide.tsx": "// コメント\n// もう一行\n<span>Send it</span>\n",
    });
    const { found } = await findSourceAnchors([text("Send it")], [root]);
    for (const place of found.get("Send it")?.places ?? []) {
      const [file, line] = [place.slice("src/".length, place.lastIndexOf(":")), place.slice(place.lastIndexOf(":") + 1)];
      const contents = await readFile(join(cwd, file), "utf8");
      expect(contents.split(/\r?\n/)[Number(line) - 1]).toContain("Send it");
    }
  });

  // A locator that matches by substring does work, so the hit is reported —
  // but "the product renders this string" is not what was found.
  it.each([
    ["<span>Archived</span>", "Archive"],
    // No word boundary to lean on in CJK, so the rule is the same one: the
    // character after the match is a letter, so this is a longer word.
    ["<span>連携すると完了する</span>", "連携する"],
  ])("says so when %s only holds %s inside a longer word", async (markup, needle) => {
    const root = await makeRoot({ "ui/Row.tsx": markup });
    const { found } = await findSourceAnchors([text(needle)], [root]);
    expect(found.get(needle)?.partial).toBe(true);
  });

  it("ignores needles shorter than 3 characters and blank needles", async () => {
    const root = await makeRoot({ "app.ts": 'const ok = "ok"; const x = "  ";' });
    const { found, unsearched } = await findSourceAnchors([text("ok"), text("  ")], [root]);
    expect(found.size).toBe(0);
    expect([...unsearched].sort()).toEqual(["  ", "ok"]);
  });
});
