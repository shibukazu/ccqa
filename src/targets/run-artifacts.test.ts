import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  collectSpecArtifacts,
  inferArtifactKind,
  specArtifactsDir,
  substituteArtifactsDir,
} from "./run-artifacts.ts";

describe("inferArtifactKind", () => {
  it("maps extensions to rendering kinds (case-insensitive), unknown/no-ext to binary", () => {
    expect(inferArtifactKind("shot.png")).toBe("image");
    expect(inferArtifactKind("photo.JPEG")).toBe("image");
    expect(inferArtifactKind("result.json")).toBe("json");
    expect(inferArtifactKind("output.log")).toBe("text");
    expect(inferArtifactKind("notes.yaml")).toBe("text");
    expect(inferArtifactKind("trace.zip")).toBe("binary");
    expect(inferArtifactKind("Makefile")).toBe("binary");
    expect(inferArtifactKind(".gitignore")).toBe("binary");
  });
});

describe("substituteArtifactsDir", () => {
  it("expands the placeholder, shell-quoting paths with unsafe characters", () => {
    expect(substituteArtifactsDir("run --out {artifactsDir}", "/tmp/a")).toBe("run --out /tmp/a");
    expect(substituteArtifactsDir("run --out {artifactsDir}", "/tmp/my dir")).toBe(
      "run --out '/tmp/my dir'",
    );
    expect(substituteArtifactsDir("run --out dist", "/tmp/a")).toBe("run --out dist");
  });
});

describe("collectSpecArtifacts", () => {
  let reportDir: string;

  beforeEach(async () => {
    reportDir = await mkdtemp(join(tmpdir(), "ccqa-artifacts-"));
  });

  afterEach(async () => {
    await rm(reportDir, { recursive: true, force: true });
  });

  it("returns [] for a missing artifacts dir", async () => {
    const rows = await collectSpecArtifacts({ reportDir, feature: "f", spec: "s", warn: () => {} });
    expect(rows).toEqual([]);
  });

  it("walks nested files into report-relative rows, output.log first", async () => {
    const dir = specArtifactsDir(reportDir, "f", "s");
    await mkdir(join(dir, "sub"), { recursive: true });
    await writeFile(join(dir, "output.log"), "$ cmd\nhello\n");
    await writeFile(join(dir, "a-shot.png"), "png-bytes");
    await writeFile(join(dir, "sub", "result.json"), "{}");
    const warnings: string[] = [];
    const rows = await collectSpecArtifacts({
      reportDir,
      feature: "f",
      spec: "s",
      warn: (m) => warnings.push(m),
    });
    expect(rows).toEqual([
      { name: "output.log", path: "artifacts/f__s/output.log", kind: "text", sizeBytes: 12 },
      { name: "a-shot.png", path: "artifacts/f__s/a-shot.png", kind: "image", sizeBytes: 9 },
      { name: "sub/result.json", path: "artifacts/f__s/sub/result.json", kind: "json", sizeBytes: 2 },
    ]);
    expect(warnings).toEqual([]);
  });

  it("caps files and bytes with an explicit warning, never dropping output.log", async () => {
    const dir = specArtifactsDir(reportDir, "f", "s");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "output.log"), "12345678"); // 8 B, exempt from caps
    await writeFile(join(dir, "a.txt"), "1234"); // fits the byte budget
    await writeFile(join(dir, "big.txt"), "123456789"); // 9 B — over the remaining budget
    await writeFile(join(dir, "c.txt"), "1234"); // a later, smaller file still fits
    await writeFile(join(dir, "d.txt"), "1234"); // over the file cap
    const warnings: string[] = [];
    const rows = await collectSpecArtifacts({
      reportDir,
      feature: "f",
      spec: "s",
      warn: (m) => warnings.push(m),
      caps: { maxFiles: 3, maxTotalBytes: 16 },
    });
    expect(rows.map((r) => r.name)).toEqual(["output.log", "a.txt", "c.txt"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("artifacts capped for f/s");
    expect(warnings[0]).toContain("big.txt (9 B)");
    expect(warnings[0]).toContain("d.txt (4 B)");
  });
});
