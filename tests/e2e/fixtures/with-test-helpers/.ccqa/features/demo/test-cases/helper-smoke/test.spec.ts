import { test } from "vitest";
import { ab } from "ccqa/test-helpers";

test("ab click via test-helpers", () => {
  ab("click", "[data-test=btn]");
});
