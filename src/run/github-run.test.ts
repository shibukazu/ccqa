import { describe, expect, test } from "vitest";
import { githubRunUrl } from "./github-run.ts";

describe("githubRunUrl", () => {
  test("builds the Actions run URL from the standard env vars", () => {
    expect(
      githubRunUrl({
        GITHUB_SERVER_URL: "https://github.com",
        GITHUB_REPOSITORY: "acme/webapp",
        GITHUB_RUN_ID: "123456",
      }),
    ).toBe("https://github.com/acme/webapp/actions/runs/123456");
  });

  test("returns null unless all three are present (never invents one)", () => {
    expect(githubRunUrl({})).toBeNull();
    expect(githubRunUrl({ GITHUB_SERVER_URL: "https://github.com" })).toBeNull();
    expect(
      githubRunUrl({ GITHUB_SERVER_URL: "https://github.com", GITHUB_REPOSITORY: "acme/webapp" }),
    ).toBeNull();
    expect(githubRunUrl({ GITHUB_REPOSITORY: "acme/webapp", GITHUB_RUN_ID: "123456" })).toBeNull();
  });
});
