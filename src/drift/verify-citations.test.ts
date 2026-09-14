import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { quotedStrings, verifyCitation, verifyCitations } from "./verify-citations.ts";

let cwd = "";

afterEach(async () => {
  if (cwd) await rm(cwd, { recursive: true, force: true });
  cwd = "";
});

async function makeRoot(files: Record<string, string>): Promise<string> {
  cwd = await mkdtemp(join(tmpdir(), "ccqa-citations-"));
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(join(cwd, path, ".."), { recursive: true });
    await writeFile(join(cwd, path), contents, "utf8");
  }
  return cwd;
}

describe("quotedStrings", () => {
  it("takes what a finding quotes, in any of the quote characters a model reaches for", () => {
    expect(quotedStrings('the source renders `Send it`, not "Submit"')).toEqual(["Send it", "Submit"]);
  });

  // Two characters inside quotes is punctuation as often as it is a citation.
  it("ignores runs too short to be worth checking a line for", () => {
    expect(quotedStrings('it returns "ok" early')).toEqual([]);
  });

  // An apostrophe closing a double quote loses the real string and invents
  // one — and an invented string that occurs somewhere moves the citation
  // there and stamps it corrected, which is the failure this module prevents.
  it("does not let one kind of quote close another", () => {
    expect(quotedStrings(`it doesn't render the "Submit" label anymore`)).toEqual(["Submit"]);
    expect(quotedStrings("the page's aria-label 'Send it' is gone")).toEqual(["Send it"]);
    expect(quotedStrings("the heading reads “Send it” now")).toEqual(["Send it"]);
  });
});

describe("verifyCitation", () => {
  const detail = 'the button reads "Send it"';

  // Nothing is added for a citation that holds what it quotes: a reader has
  // nothing to do about it, and the field exists to name exceptions.
  it("leaves a citation whose line holds the quoted string untouched", async () => {
    const root = await makeRoot({ "ui/Page.tsx": "a\nb\n<button>Send it</button>\n" });
    const out = await verifyCitation({ file: "ui/Page.tsx:3", detail }, ["Send it"], [root]);
    expect(out).toEqual({ file: "ui/Page.tsx:3", detail });
  });

  // The measured failure: right file, wrong line — a `}` or a blank one. The
  // file still shows where the string is, so the reader is sent there.
  it("corrects a line number to the line that actually holds the string", async () => {
    const root = await makeRoot({ "ui/Page.tsx": "a\nb\n}\n<button>Send it</button>\n" });
    const out = await verifyCitation({ file: "ui/Page.tsx:3", detail }, ["Send it"], [root]);
    expect(out.file).toBe("ui/Page.tsx:4");
    expect(out.citation).toBe("corrected");
  });

  it("marks a citation whose file holds the string nowhere", async () => {
    const root = await makeRoot({ "ui/Page.tsx": "a\nb\nc\n" });
    const out = await verifyCitation({ file: "ui/Page.tsx:3", detail }, ["Send it"], [root]);
    expect(out.file).toBe("ui/Page.tsx:3");
    expect(out.citation).toBe("unverified");
  });

  // Saying "wrong" about a file this process could not open would be a claim
  // about the finding rather than about the file.
  it("leaves a citation alone when the file cannot be read, or there is no line, or nothing was quoted", async () => {
    const root = await makeRoot({ "ui/Page.tsx": "<button>Send it</button>\n" });
    for (const [evidence, quoted] of [
      [{ file: "ui/Gone.tsx:3", detail }, ["Send it"]],
      [{ file: "ui/Page.tsx", detail }, ["Send it"]],
      [{ detail }, ["Send it"]],
      [{ file: "ui/Page.tsx:3", detail: "no quotes here" }, []],
    ] as const) {
      expect(await verifyCitation(evidence, quoted, [root])).toEqual(evidence);
    }
  });

  it("reads the cited path from whichever configured root holds it", async () => {
    const root = await makeRoot({ "product/ui/Page.tsx": "<button>Send it</button>\n" });
    const out = await verifyCitation({ file: "ui/Page.tsx:1", detail }, ["Send it"], [
      join(root, "nowhere"),
      join(root, "product"),
    ]);
    expect(out.citation).toBeUndefined();
  });
});

describe("verifyCitations", () => {
  it("checks each citation against what the finding and its headline quote", async () => {
    const root = await makeRoot({ "ui/Page.tsx": "x\n<button>Send it</button>\n" });
    const [checked] = await verifyCitations([{ file: "ui/Page.tsx:1", detail: "the label moved" }], {
      headline: 'the button no longer reads "Send it"',
      roots: [root],
    });
    expect(checked!.file).toBe("ui/Page.tsx:2");
    expect(checked!.citation).toBe("corrected");
  });
});
