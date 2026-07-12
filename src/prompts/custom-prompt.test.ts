import { describe, expect, test } from "vitest";
import type { HubClient } from "../hub-client/index.ts";
import type { HubContext } from "../cli/hub-conn.ts";
import {
  buildCustomPromptBlock,
  buildTriageUserPromptBlock,
  fetchCustomPrompt,
  fetchTriageUserPrompt,
  hashTriageUserPrompt,
} from "./custom-prompt.ts";

/** Minimal fake — only `getPrompt` is exercised by these tests. */
function fakeHubClient(getPrompt: HubClient["getPrompt"]): HubClient {
  return { getPrompt } as unknown as HubClient;
}

describe("buildCustomPromptBlock", () => {
  test("returns '' for a null/undefined/empty custom prompt (backward compatibility)", () => {
    expect(buildCustomPromptBlock(null)).toBe("");
    expect(buildCustomPromptBlock(undefined)).toBe("");
    expect(buildCustomPromptBlock({ schemaVersion: 1, basePromptVersion: "4", customPromptVersion: "v", generatedAt: "t", guidance: "" })).toBe("");
  });

  test("renders the learned calibration guidance", () => {
    const block = buildCustomPromptBlock({
      schemaVersion: 1,
      basePromptVersion: "4",
      customPromptVersion: "v",
      generatedAt: "t",
      guidance: "Prefer PRODUCT_BUG when the DOM is intact.",
    });
    expect(block).toContain("Calibration guidance from human-graded past failures");
    expect(block).toContain("Prefer PRODUCT_BUG when the DOM is intact.");
  });
});

describe("fetchCustomPrompt", () => {
  test("returns null when there's no hub client", async () => {
    expect(await fetchCustomPrompt(null)).toBeNull();
  });

  test("returns null when the hub has no prompt stored", async () => {
    const hub = fakeHubClient(async () => null);
    expect(await fetchCustomPrompt({ hub, project: "demo" })).toBeNull();
  });

  test("parses a valid stored custom prompt", async () => {
    const hub = fakeHubClient(async () =>
      JSON.stringify({
        schemaVersion: 1,
        basePromptVersion: "4",
        customPromptVersion: "v1",
        generatedAt: "t",
        guidance: "Prefer PRODUCT_BUG when the DOM is intact.",
      }),
    );
    const customPrompt = await fetchCustomPrompt({ hub, project: "demo" });
    expect(customPrompt?.customPromptVersion).toBe("v1");
  });

  test("returns null when getPrompt throws", async () => {
    const hub = fakeHubClient(async () => {
      throw new Error("network error");
    });
    expect(await fetchCustomPrompt({ hub, project: "demo" })).toBeNull();
  });

  test("returns null when the stored value doesn't match the schema", async () => {
    const hub = fakeHubClient(async () => JSON.stringify({ schemaVersion: 2 }));
    expect(await fetchCustomPrompt({ hub, project: "demo" })).toBeNull();
  });
});

describe("buildTriageUserPromptBlock", () => {
  test("returns '' for null/undefined/blank guidance (backward compatibility)", () => {
    expect(buildTriageUserPromptBlock(null)).toBe("");
    expect(buildTriageUserPromptBlock(undefined)).toBe("");
    expect(buildTriageUserPromptBlock("  \n ")).toBe("");
  });

  test("renders the human-maintained guidance under its own heading", () => {
    const block = buildTriageUserPromptBlock("Treat wording changes on the settings screen as SPEC_CHANGE.");
    expect(block).toContain("Project triage guidance (human-maintained)");
    expect(block).toContain("Treat wording changes on the settings screen as SPEC_CHANGE.");
  });
});

describe("fetchTriageUserPrompt", () => {
  test("returns null without a hub context / stored prompt / on fetch failure", async () => {
    expect(await fetchTriageUserPrompt(null)).toBeNull();
    expect(await fetchTriageUserPrompt({ hub: fakeHubClient(async () => null), project: "demo" })).toBeNull();
    expect(await fetchTriageUserPrompt({ hub: fakeHubClient(async () => "  \n"), project: "demo" })).toBeNull();
    const throwing = fakeHubClient(async () => {
      throw new Error("network error");
    });
    expect(await fetchTriageUserPrompt({ hub: throwing, project: "demo" })).toBeNull();
  });

  test("returns the trimmed stored markdown", async () => {
    const hub = fakeHubClient(async () => "  Prefer TEST_DRIFT for selector-only changes.\n");
    expect(await fetchTriageUserPrompt({ hub, project: "demo" })).toBe(
      "Prefer TEST_DRIFT for selector-only changes.",
    );
  });
});

describe("hashTriageUserPrompt", () => {
  test("is stable for equal input and distinguishes different input", () => {
    const a = hashTriageUserPrompt("guidance");
    expect(a).toMatch(/^[0-9a-f]{12}$/);
    expect(hashTriageUserPrompt("guidance")).toBe(a);
    expect(hashTriageUserPrompt("other")).not.toBe(a);
  });
});
