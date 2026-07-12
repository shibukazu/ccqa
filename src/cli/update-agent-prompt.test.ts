import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { HubClient } from "../hub-client/index.ts";
import { HubApiError } from "../hub-client/index.ts";
import * as log from "./logger.ts";

vi.mock("../drift/auth.ts", () => ({
  driftAuthAvailable: vi.fn(() => ({ ok: true }) as { ok: true } | { ok: false; reason: string }),
}));
vi.mock("../claude/invoke.ts", () => ({
  invokeClaudeStreaming: vi.fn(),
}));

const { driftAuthAvailable } = await import("../drift/auth.ts");
const { invokeClaudeStreaming } = await import("../claude/invoke.ts");
const { updateAgentPrompt } = await import("./update-agent-prompt.ts");

/** Minimal fake — only `getPrompt`/`putPrompt` are exercised by these tests. */
function fakeHubClient(overrides: Partial<Pick<HubClient, "getPrompt" | "putPrompt">>): HubClient {
  return {
    getPrompt: overrides.getPrompt ?? (async () => null),
    putPrompt: overrides.putPrompt ?? (async () => {}),
  } as unknown as HubClient;
}

describe("updateAgentPrompt", () => {
  beforeEach(() => {
    vi.mocked(driftAuthAvailable).mockReturnValue({ ok: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("skips (warn only) when auth is unavailable", async () => {
    vi.mocked(driftAuthAvailable).mockReturnValue({ ok: false, reason: "no ANTHROPIC_API_KEY / claude login" });
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});
    const hub = fakeHubClient({});

    await updateAgentPrompt({ mode: "live", runSummary: "summary", hubContext: { hub, project: "demo" } });

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("no ANTHROPIC_API_KEY"));
  });

  test("skips (warn only) when there's no hub connection", async () => {
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});

    await updateAgentPrompt({ mode: "record", runSummary: "summary", hubContext: null });

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("hub connection required"));
  });

  test("fetches the current prompt from the hub and writes the new one back", async () => {
    const putPrompt = vi.fn(async () => {});
    const hub = fakeHubClient({ getPrompt: async () => "old prompt", putPrompt });
    vi.mocked(invokeClaudeStreaming).mockResolvedValue({ result: "new prompt body", isError: false } as never);

    await updateAgentPrompt({ mode: "live", runSummary: "summary", hubContext: { hub, project: "demo" } });

    expect(putPrompt).toHaveBeenCalledWith("demo", "live.agent", "new prompt body\n");
  });

  test("degrades to a warning (does not throw) on a hub API error", async () => {
    const hub = fakeHubClient({ getPrompt: async () => { throw new HubApiError(503, "no_key", "no encryption key"); } });
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});

    await updateAgentPrompt({ mode: "record", runSummary: "summary", hubContext: { hub, project: "demo" } });

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("hub request failed"));
  });

  test("leaves the hub prompt unchanged when Claude returns no usable output", async () => {
    const putPrompt = vi.fn(async () => {});
    const hub = fakeHubClient({ getPrompt: async () => "old prompt", putPrompt });
    vi.mocked(invokeClaudeStreaming).mockResolvedValue({ result: "", isError: false } as never);
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});

    await updateAgentPrompt({ mode: "live", runSummary: "summary", hubContext: { hub, project: "demo" } });

    expect(putPrompt).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("no usable output"));
  });
});

describe("updateAgentPrompt NO_UPDATE sentinel", () => {
  test("leaves the prompt unchanged (info, not warn) when Claude answers NO_UPDATE", async () => {
    vi.mocked(driftAuthAvailable).mockReturnValue({ ok: true });
    const putPrompt = vi.fn(async () => {});
    const hub = fakeHubClient({ getPrompt: async () => "old prompt", putPrompt });
    vi.mocked(invokeClaudeStreaming).mockResolvedValue({ result: "NO_UPDATE\n", isError: false } as never);
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});
    const infoSpy = vi.spyOn(log, "info").mockImplementation(() => {});

    await updateAgentPrompt({ mode: "record", runSummary: "summary", hubContext: { hub, project: "demo" } });

    expect(putPrompt).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining("no new learnings"));
  });
});
