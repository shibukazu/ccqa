import { test, expect } from "vitest";

// Asserts the profile env reached the spawned vitest process. The CLI loads
// .ccqa/profiles/<name>.env and merges it into process.env before spawning
// vitest, so this var is only set when `ccqa run --profile <name>` ran.
test("profile env reached the spec", () => {
  expect(process.env.CCQA_PROFILE_BASE_URL).toBe("https://stg.example.com");
});
