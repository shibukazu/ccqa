import { beforeEach, describe, expect, it, vi } from "vitest";

import { takeScreenshot } from "./screenshot.ts";
import { spawnAB } from "./spawn-ab.ts";

vi.mock("./spawn-ab.ts", () => ({
  spawnAB: vi.fn(),
}));

const mockedSpawnAB = vi.mocked(spawnAB);

const SESSION = "test-session";
const OUT_PATH = "/tmp/shot.png";

beforeEach(() => {
  mockedSpawnAB.mockReset();
});

describe("takeScreenshot", () => {
  it("calls agent-browser screenshot with viewport-only args by default", () => {
    mockedSpawnAB.mockReturnValue({ status: 0, stdout: "", stderr: "" });

    const res = takeScreenshot(SESSION, OUT_PATH);

    expect(res).toEqual({ ok: true, path: OUT_PATH });
    expect(mockedSpawnAB).toHaveBeenCalledWith([
      "--session",
      SESSION,
      "screenshot",
      OUT_PATH,
    ]);
  });

  it("inserts --full before the output path when fullPage is set", () => {
    mockedSpawnAB.mockReturnValue({ status: 0, stdout: "", stderr: "" });

    takeScreenshot(SESSION, OUT_PATH, { fullPage: true });

    // Flag must precede the positional path arg so agent-browser parses it
    // as an option rather than a second positional.
    expect(mockedSpawnAB).toHaveBeenCalledWith([
      "--session",
      SESSION,
      "screenshot",
      "--full",
      OUT_PATH,
    ]);
  });

  it("omits --full when fullPage is explicitly false", () => {
    mockedSpawnAB.mockReturnValue({ status: 0, stdout: "", stderr: "" });

    takeScreenshot(SESSION, OUT_PATH, { fullPage: false });

    expect(mockedSpawnAB).toHaveBeenCalledWith([
      "--session",
      SESSION,
      "screenshot",
      OUT_PATH,
    ]);
  });

  it("surfaces non-zero exit as ok:false without throwing", () => {
    mockedSpawnAB.mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "no session",
    });

    const res = takeScreenshot(SESSION, OUT_PATH);

    expect(res.ok).toBe(false);
    expect(res.path).toBe(OUT_PATH);
    expect(res.error).toBe("no session");
  });
});

describe("takeScreenshot — a page that cannot be captured whole", () => {
  const failFull = (argv: string[]) =>
    argv.includes("--full")
      ? { status: 1, stdout: "", stderr: "timeout capturing full page" }
      : { status: 0, stdout: "", stderr: "" };

  it("falls back to the viewport, and stops asking for the full page on that session", () => {
    mockedSpawnAB.mockImplementation(failFull);

    const first = takeScreenshot("heavy-app", OUT_PATH, { fullPage: true });
    expect(first).toEqual({ ok: true, path: OUT_PATH, degraded: true });

    // The second step pays no failing full-page attempt: whether a page can be
    // captured whole belongs to the application, not to the step.
    mockedSpawnAB.mockClear();
    const second = takeScreenshot("heavy-app", OUT_PATH, { fullPage: true });
    expect(second).toEqual({ ok: true, path: OUT_PATH, degraded: true });
    expect(mockedSpawnAB).toHaveBeenCalledTimes(1);
    expect(mockedSpawnAB.mock.calls[0]![0]).not.toContain("--full");
  });

  // A daemon that is restarting fails both shots. Reading that as "this page
  // cannot be captured whole" would cost every later step its full-page frame.
  it("reports the failure when the viewport shot fails too, and does not give up on the session", () => {
    mockedSpawnAB.mockReturnValue({ status: 1, stdout: "", stderr: "no session" });
    const res = takeScreenshot("restarting", OUT_PATH, { fullPage: true });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("no session");

    mockedSpawnAB.mockClear();
    mockedSpawnAB.mockReturnValue({ status: 0, stdout: "", stderr: "" });
    expect(takeScreenshot("restarting", OUT_PATH, { fullPage: true })).toEqual({ ok: true, path: OUT_PATH });
    expect(mockedSpawnAB.mock.calls[0]![0]).toContain("--full");
  });
});
