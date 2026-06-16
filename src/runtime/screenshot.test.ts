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
