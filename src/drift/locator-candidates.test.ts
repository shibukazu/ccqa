import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { buildLocatorInventory, checkLocatorVerdicts, locatorsIn, type LocatorCandidate } from "./locator-candidates.ts";

describe("locatorsIn", () => {
  test("pulls the class, id and test-id tokens a selector is written with", () => {
    const { candidates } = locatorsIn(
      [
        `export const nav = page.locator(".mainnavbar");`,
        `const row = page.locator("#main > .row-item");`,
        `await page.getByTestId("submit-button").click();`,
        `page.locator('[data-testid="panel"]');`,
      ].join("\n"),
      "e2e/pages/nav.ts",
    );
    expect(candidates.map((c) => `${c.kind}:${c.value}`)).toEqual([
      "class:mainnavbar",
      "class:row-item",
      "id:main",
      "testid:submit-button",
      "testid:panel",
    ]);
    expect(candidates[0]!.from).toBe("e2e/pages/nav.ts:1");
  });

  // These are the kinds the audit already handles: they read like prose, and
  // the whole point of the scan is the kinds that do not.
  test("leaves role, text and label locators alone", () => {
    const { candidates, unresolved } = locatorsIn(
      [
        `page.getByRole("button", { name: "Save" });`,
        `page.getByText("Your changes were saved");`,
        `page.getByLabel("Email");`,
      ].join("\n"),
      "e2e/specs/save.spec.ts",
    );
    expect(candidates).toEqual([]);
    expect(unresolved).toEqual([]);
  });

  // A selector code cannot read must not become a candidate: "the product does
  // not render this" would be a claim about a string nobody has.
  test("reports a selector built from a variable or an interpolation as unresolved", () => {
    const { candidates, unresolved } = locatorsIn(
      ["page.locator(selectorFromConfig);", "page.locator(`row-${id}`);"].join("\n"),
      "e2e/pages/rows.ts",
    );
    expect(candidates).toEqual([]);
    expect(unresolved.map((u) => u.expression)).toEqual(["selectorFromConfig", "`row-${id}`"]);
  });

  // Measured: each of these put a name nobody wrote into the list the audit is
  // required to answer for — a phantom the model then investigates, and whose
  // absence a reply cannot explain.
  test("a selector assembled at run time yields no candidate, only an unresolved entry", () => {
    for (const [line, expression] of [
      ["page.locator(`.row-${id}`);", "`.row-${id}`"],
      ["page.getByTestId(`item-${id}`);", "`item-${id}`"],
      ['page.locator(".row-" + id);', '".row-" + …'],
    ] as const) {
      const { candidates, unresolved } = locatorsIn(line, "e2e/pages/rows.ts");
      expect(candidates, line).toEqual([]);
      expect(unresolved.map((u) => u.expression), line).toEqual([expression]);
    }
  });

  // A phantom candidate is worse than a missed one: the audit is then required
  // to answer for a name nobody wrote, and a reply that ignores it is rejected.
  test("a path or a fragment inside an attribute filter is not a class or an id", () => {
    const { candidates } = locatorsIn(
      [
        `page.locator('a[href="/app.html"]');`,
        `page.locator('a[href="#top"]');`,
        `page.locator('.real-one[href="/other.html"]');`,
      ].join("\n"),
      "e2e/pages/links.ts",
    );
    expect(candidates.map((c) => `${c.kind}:${c.value}`)).toEqual(["class:real-one"]);
  });

  // A TypeScript declaration is not a call, and reporting one as a selector
  // built at runtime puts a nonsense line in the audit's prompt.
  test("a typed `locator(...)` signature is not a locator call", () => {
    const { candidates, unresolved } = locatorsIn(
      `interface PageLike { locator(selector: string): LocatorLike; }`,
      "e2e/pages/types.ts",
    );
    expect(candidates).toEqual([]);
    expect(unresolved).toEqual([]);
  });

  test("a tag or structural selector carries no token, so it is neither a candidate nor unresolved", () => {
    const { candidates, unresolved } = locatorsIn(
      `page.locator("button:nth-child(2)");`,
      "e2e/pages/list.ts",
    );
    expect(candidates).toEqual([]);
    expect(unresolved).toEqual([]);
  });
});

describe("buildLocatorInventory", () => {
  let root: string | null = null;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = null;
  });

  async function product(files: Record<string, string>): Promise<string> {
    root = await mkdtemp(join(tmpdir(), "ccqa-locators-"));
    for (const [name, content] of Object.entries(files)) {
      await writeFile(join(root, name), content, "utf8");
    }
    return root;
  }

  // The measured failure: a class renamed in a support file, with the real one
  // in the product's own template. The audit read past it twice; now the class
  // arrives named.
  test("a class the product renders nowhere comes back as a candidate to check", async () => {
    const abs = await product({ "Nav.vue": `<template><nav class="mainnavbar" /></template>` });
    const inventory = await buildLocatorInventory({
      sources: new Map([["e2e/pages/nav.ts", `page.locator(".main-nav-bar")`]]),
      roots: [{ configured: "../product/src", abs }],
      cwd: "/does-not-matter",
    });
    expect(inventory.missing.map((c) => c.value)).toEqual(["main-nav-bar"]);
    expect(inventory.found).toEqual([]);
  });

  test("a class the product does render is reported found, with where", async () => {
    const abs = await product({ "Nav.vue": `<template><nav class="mainnavbar" /></template>` });
    const inventory = await buildLocatorInventory({
      sources: new Map([["e2e/pages/nav.ts", `page.locator(".mainnavbar")`]]),
      roots: [{ configured: "../product/src", abs }],
      cwd: "/does-not-matter",
    });
    expect(inventory.missing).toEqual([]);
    expect(inventory.found[0]?.at).toBe("../product/src/Nav.vue:1");
  });

  // A class name's other home. Reading only markup would report a styled-but-
  // not-yet-applied class as absent.
  test("a stylesheet counts as the product having the name", async () => {
    const abs = await product({ "theme.scss": ".row-item { color: red; }" });
    const inventory = await buildLocatorInventory({
      sources: new Map([["e2e/pages/rows.ts", `page.locator(".row-item")`]]),
      roots: [{ configured: "../product/src", abs }],
      cwd: "/does-not-matter",
    });
    expect(inventory.missing).toEqual([]);
  });

  test("a token glued inside a longer name is not that token", async () => {
    const abs = await product({ "Nav.vue": `<nav class="mainnavbar-item" />` });
    const inventory = await buildLocatorInventory({
      sources: new Map([["e2e/pages/nav.ts", `page.locator(".mainnavbar")`]]),
      roots: [{ configured: "../product/src", abs }],
      cwd: "/does-not-matter",
    });
    expect(inventory.missing.map((c) => c.value)).toEqual(["mainnavbar"]);
  });

  // A project whose tests and product are one checkout points the scan at the
  // working directory, which holds the test asking the question. Finding the
  // token there would answer every candidate "found" and make the scan inert.
  test("the file a locator is written in does not count as the product having it", async () => {
    const abs = await product({ "nav.ts": `page.locator(".mainnavbar")` });
    const inventory = await buildLocatorInventory({
      sources: new Map([["nav.ts", `page.locator(".mainnavbar")`]]),
      roots: [{ configured: ".", abs }],
      cwd: abs,
    });
    expect(inventory.missing.map((c) => c.value)).toEqual(["mainnavbar"]);
  });

  // A story is about the product, not part of it. Counting a class it holds as
  // "the product renders this" would clear a locator the product has lost —
  // and the evidence table already refuses to cite one.
  test("a class that only a story or a test holds is still missing", async () => {
    const abs = await product({
      "Nav.stories.tsx": `<nav className="mainnavbar" />`,
      "Nav.spec.tsx": `expect(page.locator(".mainnavbar"))`,
    });
    const inventory = await buildLocatorInventory({
      sources: new Map([["e2e/pages/nav.ts", `page.locator(".mainnavbar")`]]),
      roots: [{ configured: "../product/src", abs }],
      cwd: "/does-not-matter",
    });
    expect(inventory.missing.map((c) => c.value)).toEqual(["mainnavbar"]);
  });

  // A candidate that leaves the required list is one the audit is never asked
  // about — the oversight the list exists to prevent. A search cut short makes
  // the answer weaker, not the question optional.
  test("a search that runs out of budget still asks about every candidate", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 40; i++) files[`filler-${i}.tsx`] = "<div />";
    const abs = await product(files);
    const inventory = await buildLocatorInventory({
      sources: new Map([["e2e/pages/nav.ts", `page.locator(".mainnavbar")`]]),
      roots: [{ configured: "../product/src", abs }],
      cwd: "/does-not-matter",
      maxFiles: 2,
    });
    expect(inventory.missing.map((c) => c.value)).toEqual(["mainnavbar"]);
    expect(inventory.incomplete.join(" ")).toContain("mainnavbar");
  });

  test("the same token in two files is one candidate", async () => {
    const abs = await product({ "empty.ts": "" });
    const inventory = await buildLocatorInventory({
      sources: new Map([
        ["e2e/pages/a.ts", `page.locator(".shared")`],
        ["e2e/pages/b.ts", `page.locator(".shared")`],
      ]),
      roots: [{ configured: "../product/src", abs }],
      cwd: "/does-not-matter",
    });
    expect(inventory.missing.length).toBe(1);
  });
});

describe("checkLocatorVerdicts", () => {
  const candidate = (id: string): LocatorCandidate => ({
    id,
    kind: "class",
    value: `token-${id}`,
    selector: `.token-${id}`,
    from: "e2e/pages/nav.ts:1",
  });

  test("nothing to answer for when the scan found everything", () => {
    expect(checkLocatorVerdicts([], { drift: null, locators: [] })).toBeNull();
  });

  // The failure the whole list exists to close: handed a named miss, the model
  // answers "no drift" and says nothing about it.
  test("a listed locator with no verdict is rejected, and the reason names it", () => {
    const reason = checkLocatorVerdicts([candidate("L1")], { drift: null, locators: [] });
    expect(reason).toContain("L1");
    expect(reason).toContain("class token-L1");
  });

  test("a reason for the miss is an answer", () => {
    expect(
      checkLocatorVerdicts([candidate("L1")], {
        drift: null,
        locators: [{ id: "L1", verdict: "fine" }],
      }),
    ).toBeNull();
  });

  test("calling a locator drifted while calling the case clean is a contradiction", () => {
    const reason = checkLocatorVerdicts([candidate("L1")], {
      drift: null,
      locators: [{ id: "L1", verdict: "drifted" }],
    });
    expect(reason).toContain("L1");
    expect(reason).toContain("no drift");
  });

  test("drifted with a finding is accepted", () => {
    expect(
      checkLocatorVerdicts([candidate("L1")], {
        drift: { label: "TEST_DRIFT" },
        locators: [{ id: "L1", verdict: "drifted" }],
      }),
    ).toBeNull();
  });
});
