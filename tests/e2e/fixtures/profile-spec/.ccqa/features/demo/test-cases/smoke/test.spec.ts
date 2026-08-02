import { test, expect } from "vitest";

// Asserts the profile env reached the spawned vitest process. The CLI merges
// the hub profile's variables (or `<cwd>/.env`) into process.env before
// spawning vitest, so this var is only set when one of them supplied it.
test("profile env reached the spec", () => {
  expect(process.env.CCQA_PROFILE_BASE_URL).toBe("https://stg.example.com");
});
