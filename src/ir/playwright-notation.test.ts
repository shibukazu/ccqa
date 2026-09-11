import { describe, expect, test } from "vitest";
import { OPAQUE, parseNotation } from "./playwright-notation.ts";

describe("parseNotation", () => {
  test("plain css is plain css", () => {
    for (const value of [
      "[data-testid='x']", "button", ".card > .row", "#main", "[aria-label='Save']",
      // CSS's own `:has()` — real CSS the engine answers, not Playwright's.
      "div:has(> .x)", "li:has(input:checked)", `[data-testid="a:has-b"]`,
    ]) {
      expect(parseNotation(value), value).toBeNull();
    }
  });

  test("reads the string out of the text forms", () => {
    for (const value of [
      "text=Add content",
      'text="Add content"',
      ':has-text("Add content")',
    ]) {
      expect(parseNotation(value), value).toEqual({ by: "text", value: "Add content" });
    }
  });

  test("reads the role and the name out of a role form", () => {
    expect(parseNotation('role=button[name="Add content"]')).toEqual({
      by: "role",
      value: "button",
      name: "Add content",
      exact: true,
    });
  });

  // Not CSS, so `get count` answers 0 for it; not convertible, so nothing here
  // can ask it another way. Saying so is what keeps that 0 from reading as
  // "the element is not there".
  test("notation it cannot convert is called opaque, not css", () => {
    expect(parseNotation('internal:label="Email"i')).toBe(OPAQUE);
    expect(parseNotation(":text-matches('^Add')")).toBe(OPAQUE);
    expect(parseNotation("button:visible")).toBe(OPAQUE);
  });

  test("a ref carried in the text survives unresolved", () => {
    expect(parseNotation("text=note ${CCQA_RUN_ID}")).toEqual({
      by: "text",
      value: "note ${CCQA_RUN_ID}",
    });
  });
});

describe("parseNotation — what it refuses to convert", () => {
  // Dropping the qualifier would turn an assertion pinned to one button in one
  // toolbar into one that passes anywhere the word appears.
  test("a compound :has-text keeps its qualifier by staying unconvertible", () => {
    expect(parseNotation('.toolbar button:has-text("Save")')).toBe(OPAQUE);
  });

  test("quotes that are part of the string are not stripped", () => {
    expect(parseNotation('text=say "hi"')).toEqual({ by: "text", value: 'say "hi"' });
  });

  // `wait --text ""` matches trivially, which is an assertion that cannot fail.
  test("a locator that names nothing is not a locator", () => {
    expect(parseNotation("text=")).toBe(OPAQUE);
    expect(parseNotation('role=button[name=""]')).toBe(OPAQUE);
  });
});
