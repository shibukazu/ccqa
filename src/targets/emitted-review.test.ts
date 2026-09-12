import { describe, expect, test } from "vitest";
import { reviewEmittedFiles, type EmittedFinding } from "./emitted-review.ts";

const SPEC = "specs/todo/add_item.spec.ts";
const PAGE = "pages/todo/list.ts";

function review(spec: string, page = "", caseText = ["Open the list", "Add \"Buy milk\"", "The item appears on the list"]): EmittedFinding[] {
  const files = new Map([[SPEC, spec]]);
  if (page) files.set(PAGE, page);
  return reviewEmittedFiles({ files, caseText, testPath: SPEC });
}

const rules = (found: EmittedFinding[]): string[] => found.map((f) => f.rule);

describe("reviewEmittedFiles", () => {
  test("a clean test draws nothing", () => {
    const spec = `test("Adding an item puts it on the list @high", async ({ page }) => {
  await todoList.load();
  await expect(todoList.heading).toBeVisible();
});`;
    expect(review(spec, `readonly heading = this.page.getByRole("heading", { name: "The item appears on the list" });`))
      .toEqual([]);
  });

  test("a name carrying the tool's own", () => {
    const spec = `let ccqaCreated = false;\nconst ccqaRunId = uniqueId();\nawait expect(todoList.heading).toBeVisible();`;
    expect(rules(review(spec))).toEqual(["tool-identifier", "tool-identifier"]);
  });

  // The name says "one of the things in a list"; the locator finds the string
  // anywhere — a heading, a toast, another row.
  test("a container built from a match against the whole page, as a field or a method", () => {
    const page = `readonly firstCard = this.page.getByText("Buy milk");
  contentRow(title: string): Locator {
    return this.page.getByText(title);
  }`;
    expect(rules(review(`await expect(todoList.firstCard).toBeVisible();`, page)))
      .toEqual(["unscoped-container", "unscoped-container"]);
  });

  // The shape a fix pass reached for when the finding named only `getByText`:
  // the same page-wide search, now resting on DOM order.
  test("a container found by searching the page for a bare tag is the same fault", () => {
    const page = `readonly itemCard = this.page.locator("div").filter({ hasText: "Buy milk" }).last();`;
    expect(rules(review(`await expect(todoList.itemCard).toBeVisible();`, page)))
      .toEqual(["unscoped-container"]);
  });

  test("a container scoped to something is left alone", () => {
    const byRole = `readonly firstCard = this.page.getByRole("row").filter({ hasText: "Buy milk" });`;
    expect(review(`await expect(todoList.firstCard).toBeVisible();`, byRole)).toEqual([]);
    // Starting from a container this page object already addresses, which is
    // how the hand-written ones reach a structural tag.
    const scoped = `readonly firstCard = this.listSection.locator("div").filter({ hasText: "Buy milk" }).last();`;
    expect(review(`await expect(todoList.firstCard).toBeVisible();`, scoped)).toEqual([]);
  });

  describe("an unusual choice is allowed, and has to be said", () => {
    test("`.first()` on an assertion, unexplained and explained", () => {
      const bare = `await expect(todoList.rows.first()).toBeVisible();`;
      expect(rules(review(bare))).toEqual(["unjustified-first"]);
      expect(review(`// the newest row is the top one\n${bare}`)).toEqual([]);
    });

    // Following `.first()` into the page object fired on thirty hand-written
    // assertions: resolving a repeated element once, for every caller, is how
    // that is normally written.
    test("`.first()` where the page object defined it is not the assertion's doing", () => {
      const page = `readonly rows = this.page.getByRole("row").first();`;
      expect(review(`await expect(todoList.rows).toBeVisible();`, page)).toEqual([]);
    });

    test("an assertion about something the case never mentions", () => {
      const bare = `await expect(page.getByText("Manage your items here.")).toBeVisible();`;
      expect(rules(review(bare))).toEqual(["unasked-assertion"]);
      expect(review(`// precondition: the banner is still the old one\n${bare}`)).toEqual([]);
    });
  });

  test("the case's own words are found through the page object that holds them", () => {
    const page = `readonly done = this.page.getByText("The item appears on the list");`;
    expect(review(`await expect(todoList.done).toBeVisible();`, page)).toEqual([]);
  });

  // A URL pattern or a value the test computed has nothing to compare against.
  test("an assertion looking for no string at all is not judged", () => {
    expect(review(`await expect(page).toHaveURL(/\\/todos/);`)).toEqual([]);
    expect(review(`await expect(todoList.row(itemTitle)).toBeVisible();`)).toEqual([]);
  });

  // The floor under a case whose expectations are stated for the flow: the
  // reading is the only thing that looks at those, and a reading is a model's.
  // That a file decides nothing at all needs no reading. Of 546 hand-written
  // specs in a real suite, none has zero assertions.
  test("a test that decides nothing at all", () => {
    const spec = `test("Adding an item puts it on the list @high", async ({ page }) => {
  await todoList.load();
  await todoList.addItem("Buy milk");
});`;
    expect(rules(review(spec))).toEqual(["decides-nothing"]);
  });

  test("a case that states nothing has nothing to be checked against", () => {
    const spec = `test("x", async ({ page }) => { await todoList.load(); });`;
    expect(review(spec, "", [])).toEqual([]);
  });

  // Two names for one string, one of them strictly weaker. Of 214 hand-written
  // page objects in a real suite the shape appears once, in a file a
  // generation wrote — people do not write it.
  test("a weaker twin of a locator the file already has", () => {
    const page = `readonly heading = this.page.getByRole("heading", { name: "Settings" });
readonly headingText = this.page.getByText("Settings").first();`;
    const spec = `await expect(settings.heading).toBeVisible();
await expect(settings.headingText).toBeVisible();`;
    const found = review(spec, page, ["Open Settings", "The Settings heading is shown"]);
    expect(rules(found)).toEqual(["weaker-twin"]);
    expect(found[0]!.message).toContain("headingText");
    expect(found[0]!.message).toContain("heading");
  });

  test("two names for one string are fine when neither is the weaker shape", () => {
    const page = `readonly heading = this.page.getByRole("heading", { name: "Settings" });
readonly tab = this.page.getByRole("tab", { name: "Settings" });`;
    const spec = `await expect(settings.heading).toBeVisible();
await expect(settings.tab).toBeVisible();`;
    expect(rules(review(spec, page, ["Open Settings", "The Settings heading is shown"]))).toEqual([]);
  });

  // Both halves matter: a page object exists to be shared, so "this case does
  // not use it" is not "nobody does" until the project has been asked.
  test("a definition nothing in the project reaches", () => {
    const page = `readonly heading = this.page.getByRole("heading", { name: "The item appears on the list" });
readonly unusedLabel = this.page.getByText("Title");`;
    const spec = `await expect(todoList.heading).toBeVisible();`;
    const found = reviewEmittedFiles({
      files: new Map([[SPEC, spec], [PAGE, page]]),
      caseText: ["Open the list", "The item appears on the list"],
      testPath: SPEC,
      usedInProject: new Map([[PAGE, new Set<string>()]]),
    });
    expect(rules(found)).toEqual(["unreached"]);
    expect(found[0]!.message).toContain("unusedLabel");
  });

  test("a definition another case in the project reaches is not dead", () => {
    const page = `readonly heading = this.page.getByRole("heading", { name: "The item appears on the list" });
readonly unusedLabel = this.page.getByText("Title");`;
    const spec = `await expect(todoList.heading).toBeVisible();`;
    const found = reviewEmittedFiles({
      files: new Map([[SPEC, spec], [PAGE, page]]),
      caseText: ["Open the list", "The item appears on the list"],
      testPath: SPEC,
      usedInProject: new Map([[PAGE, new Set(["unusedLabel"])]]),
    });
    expect(rules(found)).toEqual([]);
  });

  // A placeholder path in an expectation is a claim about the address. What
  // the screen shows can be right while the screen is wrong.
  test("a case that says where the run ends up, and a test that never looks", () => {
    const spec = `await expect(todoList.row("Buy milk")).toBeVisible();`;
    const said = ["Open the list", "The item is shown on /lists/{listId}"];
    expect(rules(review(spec, "", said))).toContain("unasserted-path");
  });

  test("says nothing once the address is asserted", () => {
    const spec = `await expect(page).toHaveURL(/\\/lists\\/[^/]+/);
await expect(todoList.row("Buy milk")).toBeVisible();`;
    const said = ["Open the list", "The item is shown on /lists/{listId}"];
    expect(rules(review(spec, "", said))).not.toContain("unasserted-path");
  });

  // A path named as scenery is not a claim about where the run ends up.
  test("says nothing about a path with no placeholder in it", () => {
    const spec = `await expect(todoList.row("Buy milk")).toBeVisible();`;
    const said = ["Open the list", "On /lists the add button is shown"];
    expect(rules(review(spec, "", said))).not.toContain("unasserted-path");
  });

  // Property names are not unique across a suite: one real project has
  // `deleteSuccessToast` on four unrelated page objects. A flat set of every
  // identifier in the project answers "somebody uses that word", which is not
  // the question — so the caller scopes the set to this file.
  test("a name another page object also uses is still unreached here", () => {
    const page = `export class TodoList {
  readonly heading = this.page.getByRole("heading", { name: "The item appears on the list" });
  readonly deleteSuccessToast = this.page.getByText("Deleted");
}`;
    const spec = `const todoList = new TodoList(page);
await expect(todoList.heading).toBeVisible();`;
    const found = reviewEmittedFiles({
      files: new Map([[SPEC, spec], [PAGE, page]]),
      caseText: ["Open the list", "The item appears on the list"],
      testPath: SPEC,
      // Scoped to this file: whatever another page object calls its own toast
      // never lands here. The class itself is reached — the spec constructs it.
      usedInProject: new Map([[PAGE, new Set(["TodoList"])]]),
    });
    expect(rules(found)).toEqual(["unreached"]);
    expect(found[0]!.message).toContain("deleteSuccessToast");
  });

  test("a describe repeating its only test", () => {
    const spec = `test.describe("Adding an item puts it on the list", () => {
  test("Adding an item puts it on the list @high", async ({ page }) => {
    await expect(todoList.heading).toBeVisible();
  });
});`;
    expect(rules(review(spec))).toEqual(["describe-echo"]);
  });

  test("a describe over several tests, or naming something else, is left alone", () => {
    const two = `test.describe("Adding an item puts it on the list", () => {
  test("Adding an item puts it on the list @high", async ({ page }) => {
    await expect(todoList.heading).toBeVisible();
  });
  test("Removing it takes it off the list @high", async ({ page }) => {
    await expect(todoList.heading).toHaveCount(0);
  });
});`;
    expect(review(two)).toEqual([]);
    const named = `test.describe("The todo list", () => {
  test("Adding an item puts it on the list @high", async ({ page }) => {
    await expect(todoList.heading).toBeVisible();
  });
});`;
    expect(review(named)).toEqual([]);
  });
});
