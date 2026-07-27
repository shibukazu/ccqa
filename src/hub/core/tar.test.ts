import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import { packFilesToTarGz, packTarGz, unpackTarGz, type TarEntry } from "./tar.ts";

const execFileP = promisify(execFile);

describe("packTarGz / unpackTarGz round-trip", () => {
  let destDir: string | null = null;

  afterEach(async () => {
    if (destDir) {
      await rm(destDir, { recursive: true, force: true });
      destDir = null;
    }
  });

  test("round-trips nested directories and file contents", async () => {
    const entries: TarEntry[] = [
      { path: "a.txt", content: new TextEncoder().encode("hello"), mode: 0o644 },
      { path: "dir/", mode: 0o755 },
      { path: "dir/nested/b.txt", content: new TextEncoder().encode("world"), mode: 0o644 },
    ];
    const archive = packTarGz(entries);
    destDir = await mkdtemp(join(tmpdir(), "ccqa-tar-"));
    await unpackTarGz(archive, destDir);

    expect(await readFile(join(destDir, "a.txt"), "utf8")).toBe("hello");
    expect(await readFile(join(destDir, "dir/nested/b.txt"), "utf8")).toBe("world");
  });

  test("preserves file mode bits", async () => {
    const entries: TarEntry[] = [
      { path: "exec.sh", content: new TextEncoder().encode("#!/bin/sh\n"), mode: 0o755 },
    ];
    const archive = packTarGz(entries);
    destDir = await mkdtemp(join(tmpdir(), "ccqa-tar-"));
    await unpackTarGz(archive, destDir);
    const st = await stat(join(destDir, "exec.sh"));
    expect(st.mode & 0o777).toBe(0o755);
  });

  test("round-trips a path at the ustar 100-byte name boundary via the prefix field", async () => {
    const longDir = "a".repeat(80) + "/" + "b".repeat(80);
    const path = `${longDir}/file.txt`;
    const entries: TarEntry[] = [{ path, content: new TextEncoder().encode("x"), mode: 0o644 }];
    const archive = packTarGz(entries);
    destDir = await mkdtemp(join(tmpdir(), "ccqa-tar-"));
    await unpackTarGz(archive, destDir);
    expect(await readFile(join(destDir, path), "utf8")).toBe("x");
  });

  test("empty file round-trips", async () => {
    const entries: TarEntry[] = [{ path: "empty.txt", content: new Uint8Array(0), mode: 0o644 }];
    const archive = packTarGz(entries);
    destDir = await mkdtemp(join(tmpdir(), "ccqa-tar-"));
    await unpackTarGz(archive, destDir);
    expect(await readFile(join(destDir, "empty.txt"), "utf8")).toBe("");
  });

  test("round-trips a path with no valid ustar split via a pax header", async () => {
    // Long overall, but every component stays under the filesystem's own
    // 255-byte name limit — the point is the tar format, not the OS.
    const path = `${"a".repeat(200)}/${"b".repeat(200)}`;
    const archive = packTarGz([{ path, content: new TextEncoder().encode("long"), mode: 0o644 }]);
    destDir = await mkdtemp(join(tmpdir(), "ccqa-tar-"));
    await unpackTarGz(archive, destDir);
    expect(await readFile(join(destDir, path), "utf8")).toBe("long");
  });

  test("round-trips a multi-byte path component longer than the name field", async () => {
    // The shape that made every failing non-ASCII-titled spec unpushable: a
    // test runner names its artifact dir after the test title, and one such
    // component alone exceeds 100 bytes in UTF-8, so no split point exists.
    // The repeated character stands in for such a title — what the test is
    // about is the byte width, not the words.
    const dir = "artifacts/spec__case";
    const name = `artifacts-run-${"あ".repeat(40)}-trace`;
    expect(Buffer.byteLength(name, "utf8")).toBeGreaterThan(100);
    const path = `${dir}/${name}/trace.zip`;
    const archive = packTarGz([{ path, content: new TextEncoder().encode("zip"), mode: 0o644 }]);
    destDir = await mkdtemp(join(tmpdir(), "ccqa-tar-"));
    await unpackTarGz(archive, destDir);
    expect(await readFile(join(destDir, path), "utf8")).toBe("zip");
  });

  test("round-trips the maximum ustar path, and one byte past it via pax", async () => {
    // Exactly 155-byte prefix + 100-byte name: the largest path ustar can hold.
    const maxPath = `${"p".repeat(155)}/${"n".repeat(100)}`;
    const archive = packTarGz([
      { path: maxPath, content: new TextEncoder().encode("max"), mode: 0o644 },
    ]);
    destDir = await mkdtemp(join(tmpdir(), "ccqa-tar-"));
    await unpackTarGz(archive, destDir);
    expect(await readFile(join(destDir, maxPath), "utf8")).toBe("max");

    // One extra prefix byte leaves no slash with prefix <= 155 and name <= 100,
    // so this one goes out as pax rather than being rejected.
    const overPath = `${"p".repeat(156)}/${"n".repeat(100)}`;
    const overArchive = packTarGz([
      { path: overPath, content: new TextEncoder().encode("over"), mode: 0o644 },
    ]);
    await unpackTarGz(overArchive, destDir);
    expect(await readFile(join(destDir, overPath), "utf8")).toBe("over");
  });

  test("produces archives the system tar accepts", async () => {
    // Our own unpack never verifies header checksums, so round-trip tests
    // alone cannot catch header-format bugs. Extracting with the system tar
    // validates the checksum and prefix/name split against an independent
    // implementation. The long dir forces the prefix field into play, and the
    // multi-byte one forces a pax extended header — the claim that a downloaded
    // bundle still extracts with the system tar has to be checked, not assumed.
    const longDir = "d".repeat(120);
    const paxDir = `artifacts-${"あ".repeat(40)}-run`;
    const entries: TarEntry[] = [
      { path: "a.txt", content: new TextEncoder().encode("hello"), mode: 0o644 },
      { path: `${longDir}/deep.txt`, content: new TextEncoder().encode("deep"), mode: 0o644 },
      { path: `${paxDir}/trace.zip`, content: new TextEncoder().encode("pax"), mode: 0o644 },
    ];
    destDir = await mkdtemp(join(tmpdir(), "ccqa-tar-"));
    const archivePath = join(destDir, "snapshot.tar.gz");
    await writeFile(archivePath, packTarGz(entries));
    const extractDir = join(destDir, "extracted");
    await mkdir(extractDir);

    await execFileP("tar", ["-xzf", archivePath, "-C", extractDir]);

    expect(await readFile(join(extractDir, "a.txt"), "utf8")).toBe("hello");
    expect(await readFile(join(extractDir, longDir, "deep.txt"), "utf8")).toBe("deep");
    expect(await readFile(join(extractDir, paxDir, "trace.zip"), "utf8")).toBe("pax");
  });

  test("unpack refuses a path traversal entry ('..' segment)", async () => {
    destDir = await mkdtemp(join(tmpdir(), "ccqa-tar-"));
    // Packing itself doesn't validate path safety (that's unpack's job) — build
    // the archive, then unpack should reject the '..' segment.
    const entries: TarEntry[] = [{ path: "../escape.txt", content: new Uint8Array(1), mode: 0o644 }];
    const archive = packTarGz(entries);
    await expect(unpackTarGz(archive, destDir)).rejects.toThrow(/unsafe tar entry path/);
  });
});

describe("packFilesToTarGz", () => {
  let rootDir: string | null = null;
  let destDir: string | null = null;

  afterEach(async () => {
    if (rootDir) await rm(rootDir, { recursive: true, force: true });
    if (destDir) await rm(destDir, { recursive: true, force: true });
    rootDir = null;
    destDir = null;
  });

  test("packs real files from disk and unpacks them with matching content", async () => {
    rootDir = await mkdtemp(join(tmpdir(), "ccqa-tar-src-"));
    await mkdir(join(rootDir, "sub"), { recursive: true });
    await writeFile(join(rootDir, "top.txt"), "top-level");
    await writeFile(join(rootDir, "sub/nested.txt"), "nested-content");

    const archive = await packFilesToTarGz(rootDir, ["top.txt", "sub/nested.txt"]);
    destDir = await mkdtemp(join(tmpdir(), "ccqa-tar-dest-"));
    await unpackTarGz(archive, destDir);

    expect(await readFile(join(destDir, "top.txt"), "utf8")).toBe("top-level");
    expect(await readFile(join(destDir, "sub/nested.txt"), "utf8")).toBe("nested-content");
  });

  test("includes extraEntries alongside files packed from disk", async () => {
    rootDir = await mkdtemp(join(tmpdir(), "ccqa-tar-src-"));
    await writeFile(join(rootDir, "a.txt"), "a");

    const archive = await packFilesToTarGz(rootDir, ["a.txt"], [
      { path: "manifest.json", content: new TextEncoder().encode('{"ok":true}'), mode: 0o644 },
    ]);
    destDir = await mkdtemp(join(tmpdir(), "ccqa-tar-dest-"));
    await unpackTarGz(archive, destDir);

    expect(await readFile(join(destDir, "a.txt"), "utf8")).toBe("a");
    expect(await readFile(join(destDir, "manifest.json"), "utf8")).toBe('{"ok":true}');
  });
});
