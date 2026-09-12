import { describe, expect, test } from "vitest";
import { nameFromAttributeSelector, roleOfAccessibleName } from "./accessible-name.ts";

describe("nameFromAttributeSelector", () => {
  test("reads the name out of an aria-label selector, in either quote style", () => {
    expect(nameFromAttributeSelector("[aria-label='Priority *']")).toBe("Priority *");
    expect(nameFromAttributeSelector('[aria-label="Save"]')).toBe("Save");
  });

  // Anything else is a selector that means what it says, and a zero from it is
  // evidence. Only a naming attribute can be absent while the name is not.
  test("asks nothing of a selector that is not naming an element", () => {
    for (const value of [
      "[data-testid='save']",
      "[aria-label='Save'] .row",
      "button",
      "[type='password']",
      "[aria-label='']",
      // Attributes that mean what they say: a zero from one is evidence.
      "[name='email']",
      "[title='Close']",
    ]) {
      expect(nameFromAttributeSelector(value), value).toBeNull();
    }
  });
});

describe("roleOfAccessibleName", () => {
  const SNAPSHOT = [
    "- document",
    '  - banner "Site header"',
    '    - link "Home"',
    '  - combobox "Priority *"',
    '  - button "Save"',
  ].join("\n");

  test("answers with the role of the node carrying that exact name", () => {
    expect(roleOfAccessibleName(SNAPSHOT, "Priority *")).toBe("combobox");
    expect(roleOfAccessibleName(SNAPSHOT, "Save")).toBe("button");
  });

  // The name asked for is the whole name: a tree holding both "Priority" and
  // "Priority *" must answer for the one the locator named.
  test("does not answer for a name that is only a prefix of one", () => {
    expect(roleOfAccessibleName(SNAPSHOT, "Priority")).toBeNull();
    expect(roleOfAccessibleName(SNAPSHOT, "Sav")).toBeNull();
  });

  test("a name the tree does not carry has no role", () => {
    expect(roleOfAccessibleName(SNAPSHOT, "Delete")).toBeNull();
  });

  // A nav link above the form's button would otherwise turn an assertion about
  // the button into a permanent green check on the link.
  test("refuses a name two different roles carry", () => {
    const ambiguous = ['- link "Save"', '- button "Save"'].join("\n");
    expect(roleOfAccessibleName(ambiguous, "Save")).toBeNull();
  });

  test("the same role twice is not ambiguous", () => {
    const twice = ['- button "Save"', '- button "Save"'].join("\n");
    expect(roleOfAccessibleName(twice, "Save")).toBe("button");
  });
});
