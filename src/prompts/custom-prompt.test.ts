import { describe, expect, test } from "vitest";
import type { HubClient } from "../hub-client/index.ts";
import type { HubContext } from "../cli/hub-conn.ts";
import { buildCustomPromptBlock, fetchCustomPrompt } from "./custom-prompt.ts";

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
