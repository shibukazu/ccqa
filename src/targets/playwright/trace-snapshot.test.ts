import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openSnapshotRenderer } from "./trace-snapshot.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A project whose Playwright has a viewer and a browser that fails to close. */
function project(): string {
  const cwd = mkdtempSync(join(tmpdir(), "ccqa-snapshot-"));
  dirs.push(cwd);
  const core = join(cwd, "node_modules", "playwright-core");
  mkdirSync(join(core, "lib", "vite", "traceViewer"), { recursive: true });
  writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "consumer" }));
  writeFileSync(join(core, "package.json"), JSON.stringify({ name: "playwright-core", main: "./index.js" }));
  writeFileSync(join(core, "lib", "vite", "traceViewer", "snapshot.html"), "<html></html>");
  writeFileSync(
    join(core, "index.js"),
    [
      "const page = {",
      "  setDefaultTimeout() {},",
      "  async goto(url) { globalThis.__ccqaViewerUrl = url; },",
      "  async waitForFunction() {},",
      "  async evaluate() { return true; },",
      "};",
      "exports.chromium = { launch: async () => ({",
      "  newPage: async () => page,",
      "  close: async () => { throw new Error('browser gone'); },",
      "}) };",
    ].join("\n"),
  );
  return cwd;
}

describe("openSnapshotRenderer", () => {
  it("stops serving the viewer even when the browser fails to close", async () => {
    const cwd = project();
    const renderer = await openSnapshotRenderer([cwd], join(cwd, "trace.zip"));
    const viewer = (globalThis as { __ccqaViewerUrl?: string }).__ccqaViewerUrl!;
    expect((await fetch(viewer)).status).toBe(200);

    await expect(renderer.close()).rejects.toThrow("browser gone");
    await expect(fetch(viewer)).rejects.toThrow();
  });
});
