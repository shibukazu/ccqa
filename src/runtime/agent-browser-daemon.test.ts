import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { agentBrowserRuntimeDir, killSessionDaemon, readDaemonPid } from "./agent-browser-daemon.ts";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));

const mockedSpawnSync = vi.mocked(spawnSync);
const psOut = (stdout: string) => ({ status: 0, stdout }) as unknown as ReturnType<typeof spawnSync>;

const savedEnv = { ...process.env };

beforeEach(() => {
  mockedSpawnSync.mockReset();
  delete process.env["AGENT_BROWSER_SOCKET_DIR"];
  delete process.env["XDG_RUNTIME_DIR"];
});
afterEach(() => {
  process.env = { ...savedEnv };
});

describe("agentBrowserRuntimeDir", () => {
  // The layout these encode was measured against agent-browser 0.26-0.34; a
  // wrong directory makes every kill a silent no-op.
  it("takes AGENT_BROWSER_SOCKET_DIR verbatim, ahead of XDG_RUNTIME_DIR", () => {
    process.env["AGENT_BROWSER_SOCKET_DIR"] = "/run/sockets";
    process.env["XDG_RUNTIME_DIR"] = "/run/user/1000";
    expect(agentBrowserRuntimeDir()).toBe("/run/sockets");
  });

  it("appends an agent-browser subdirectory to XDG_RUNTIME_DIR", () => {
    process.env["XDG_RUNTIME_DIR"] = "/run/user/1000";
    expect(agentBrowserRuntimeDir()).toBe(join("/run/user/1000", "agent-browser"));
  });

  it("falls back to the home directory", () => {
    expect(agentBrowserRuntimeDir()).toMatch(/\.agent-browser$/);
  });
});

describe("readDaemonPid", () => {
  it("reads the pid, and rejects a file that does not hold one", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccqa-daemon-"));
    process.env["AGENT_BROWSER_SOCKET_DIR"] = dir;
    writeFileSync(join(dir, "good.pid"), "4321\n");
    writeFileSync(join(dir, "junk.pid"), "not-a-pid");
    expect(readDaemonPid("good")).toBe(4321);
    expect(readDaemonPid("junk")).toBeNull();
    expect(readDaemonPid("absent")).toBeNull();
  });
});

describe("killSessionDaemon", () => {
  it("refuses to signal a pid that is no longer agent-browser", async () => {
    // A pid file outlives an unclean exit, so its number may have been reused.
    const dir = mkdtempSync(join(tmpdir(), "ccqa-daemon-"));
    process.env["AGENT_BROWSER_SOCKET_DIR"] = dir;
    writeFileSync(join(dir, "sess.pid"), String(process.pid));
    mockedSpawnSync.mockReturnValue(psOut("/usr/bin/some-unrelated-process\n"));
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);

    await expect(killSessionDaemon("sess")).resolves.toEqual({
      killed: false,
      reason: `pid ${process.pid} is not an agent-browser process`,
    });
    expect(kill).not.toHaveBeenCalledWith(process.pid, "SIGTERM");
    kill.mockRestore();
  });

  it("stops at SIGTERM when the daemon exits, so its browser goes down with it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ccqa-daemon-"));
    process.env["AGENT_BROWSER_SOCKET_DIR"] = dir;
    writeFileSync(join(dir, "sess.pid"), "4321");
    mockedSpawnSync.mockReturnValue(psOut("/path/to/agent-browser-linux-x64\n"));

    let alive = true;
    const kill = vi
      .spyOn(process, "kill")
      .mockImplementation(((pid: number, signal?: string | number) => {
        if (signal === "SIGTERM") alive = false;
        if (signal === 0 && !alive) throw new Error("ESRCH");
        return true;
      }) as typeof process.kill);

    await expect(killSessionDaemon("sess")).resolves.toEqual({ killed: true, pid: 4321 });
    expect(kill).toHaveBeenCalledWith(4321, "SIGTERM");
    expect(kill).not.toHaveBeenCalledWith(4321, "SIGKILL");
    kill.mockRestore();
  });
});
