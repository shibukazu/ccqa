import { describe, expect, test } from "vitest";
import { reviewEmittedFiles, type EmittedFinding } from "./emitted-review.ts";

const SPEC = "specs/todo/add_item.spec.ts";
const PAGE = "pages/todo/list.ts";

function review(spec: string, page = "", caseText = ["Open the list", "Add \"Buy milk\"", "The item appears on the list"]): EmittedFinding[] {
  const files = new Map([[SPEC, spec]]);
  if (page) files.set(PAGE, page);
  return reviewEmittedFiles({ files, caseText });
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
    const spec = `let ccqaCreated = false;\nconst ccqaRunId = uniqueId();`;
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
    const page = `readonly notionCard = this.page.locator("div").filter({ hasText: "Buy milk" }).last();`;
    expect(rules(review(`await expect(todoList.notionCard).toBeVisible();`, page)))
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
      const bare = `await expect(page.getByText("Manage your integrations here.")).toBeVisible();`;
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

  test("a describe repeating its only test", () => {
    const spec = `test.describe("Adding an item puts it on the list", () => {
  test("Adding an item puts it on the list @high", async ({ page }) => {});
});`;
    expect(rules(review(spec))).toEqual(["describe-echo"]);
  });

  test("a describe over several tests, or naming something else, is left alone", () => {
    const two = `test.describe("Adding an item puts it on the list", () => {
  test("Adding an item puts it on the list @high", async ({ page }) => {});
  test("Removing it takes it off the list @high", async ({ page }) => {});
});`;
    expect(review(two)).toEqual([]);
    const named = `test.describe("The todo list", () => {
  test("Adding an item puts it on the list @high", async ({ page }) => {});
});`;
    expect(review(named)).toEqual([]);
  });
});
