import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("./screenshot.ts", () => ({ takeScreenshot: vi.fn() }));
vi.mock("./session-state.ts", () => ({ reviveSession: vi.fn() }));

const { takeScreenshot } = await import("./screenshot.ts");
const { reviveSession } = await import("./session-state.ts");
const { screenshotWithRecovery } = await import("./screenshot-recovery.ts");

const shot = vi.mocked(takeScreenshot);
const revive = vi.mocked(reviveSession);

const OUT = "/tmp/after.png";
const WEDGED = {
  ok: false,
  path: OUT,
  error: "[ccqa] agent-browser screenshot did not answer in 20000ms",
  wedged: true,
} as const;
const TAKEN = { ok: true, path: OUT } as const;

function ask(recovery = { spent: false }): ReturnType<typeof screenshotWithRecovery> {
  return screenshotWithRecovery({
    sessionName: "live-1",
    outPath: OUT,
    label: "after, step-01",
    fullPage: true,
    statePath: "/tmp/state.json",
    verifyUrl: "https://example.test/home",
    recovery,
  });
}

beforeEach(() => {
  shot.mockReset();
  revive.mockReset();
});

describe("screenshotWithRecovery", () => {
  // Measured on a heavy application: every step's frame was lost this way, and
  // the viewport fallback never ran because the daemon answered neither shot.
  test("a wedged daemon is revived, and the frame is retaken viewport-only", async () => {
    shot.mockReturnValueOnce(WEDGED).mockReturnValueOnce(TAKEN);
    revive.mockResolvedValue(true);

    // A full page was asked for and a viewport frame is what came back.
    await expect(ask()).resolves.toEqual({ ...TAKEN, degraded: true });
    expect(revive).toHaveBeenCalledWith(
      "live-1",
      "/tmp/state.json",
      "https://example.test/home",
      expect.stringContaining("after, step-01"),
    );
    // The retake asks for no full page: one is what the daemon choked on.
    expect(shot.mock.calls[1]).toEqual(["live-1", OUT]);
  });

  test("a shot that simply failed is left alone — nothing here is wrong with the session", async () => {
    shot.mockReturnValue({ ok: false, path: OUT, error: "no such element" });

    await expect(ask()).resolves.toEqual({ ok: false, path: OUT, error: "no such element" });
    expect(revive).not.toHaveBeenCalled();
  });

  test("a revive that did not take costs this step its frame and nothing more", async () => {
    shot.mockReturnValue(WEDGED);
    revive.mockResolvedValue(false);

    await expect(ask()).resolves.toEqual(WEDGED);
    expect(shot).toHaveBeenCalledTimes(1);
  });

  // Reviving is a SIGTERM poll plus a reboot of the application that just
  // wedged. The before-shot, the after-shot and the health probe all notice the
  // same daemon, and the step is worth one of those between them.
  test("a step that has already spent its recovery does not spend another", async () => {
    shot.mockReturnValue(WEDGED);

    await expect(ask({ spent: true })).resolves.toEqual(WEDGED);
    expect(revive).not.toHaveBeenCalled();
  });
});
