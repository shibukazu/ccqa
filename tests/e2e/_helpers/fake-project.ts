import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const FIXTURES_ROOT = resolve(__dirname, "..", "fixtures");
const REPO_ROOT = resolve(__dirname, "..", "..", "..");

export type FakeProject = {
  cwd: string;
  cleanup: () => Promise<void>;
};

// Copies a fixture directory into a fresh temp dir so each test runs in
// isolation. When `linkCcqa` is true we also populate node_modules with
// the minimum needed for `ccqa run` to work inside the fixture:
//   - node_modules/ccqa: materialized (not symlinked) copy of the repo's
//     bin/ + src/ + package.json. Symlinking would let Node follow the
//     link to REPO_ROOT and resolve peer deps (agent-browser) from the
//     repo's node_modules, bypassing any fakes under <fixture>/node_modules.
//   - node_modules/vitest: symlink to the repo's installed copy. Under
//     pnpm the repo link itself points at .pnpm/<pkg>/node_modules/vitest,
//     so vitest's own transitive deps resolve without us enumerating them.
export async function makeFakeProject(
  fixtureName: string,
  opts: { linkCcqa?: boolean; ccqaTarget?: "src" | "dist" } = {},
): Promise<FakeProject> {
  const src = join(FIXTURES_ROOT, fixtureName);
  const cwd = await mkdtemp(join(tmpdir(), `ccqa-e2e-${fixtureName}-`));
  await cp(src, cwd, { recursive: true });

  if (opts.linkCcqa) {
    const nm = join(cwd, "node_modules");
    await mkdir(nm, { recursive: true });
    await materializeCcqaPackage(join(nm, "ccqa"), { target: opts.ccqaTarget ?? "src" });
    await symlink(
      join(REPO_ROOT, "node_modules", "vitest"),
      join(nm, "vitest"),
      "dir",
    ).catch(() => {});
  }

  return {
    cwd,
    cleanup: async () => {
      await rm(cwd, { recursive: true, force: true });
    },
  };
}

export function fixturePath(fixtureName: string): string {
  return join(FIXTURES_ROOT, fixtureName);
}

// Copies the ccqa package contents that consumers actually import into a
// fresh directory under the fixture's node_modules. Symlinking would let
// Node resolve peer deps (agent-browser) from the repo's node_modules,
// bypassing any fakes the test sets up — so we copy instead.
//
// Two shapes, selected by `target`:
//   "src" (default) — copy bin/ + src/ and rewrite package.json's bin/exports
//     to those source files, so the E2E suite can exercise the CLI without a
//     fresh `pnpm build`. Node strips the .ts at runtime via
//     --experimental-strip-types.
//   "dist" — copy the built dist/ and keep package.json's real published
//     bin/exports/files untouched, so a spec's `import "ccqa/test-helpers"`
//     exercises the exact subpath resolution (import condition, .mjs, dist
//     paths) a consumer hits after install. Requires a built dist/; only
//     shebang.test.ts uses it, guarded behind distBuilt.
async function materializeCcqaPackage(
  destDir: string,
  opts: { target: "src" | "dist" },
): Promise<void> {
  await mkdir(destDir, { recursive: true });
  const pkgJson = JSON.parse(
    await readFile(join(REPO_ROOT, "package.json"), "utf8"),
  ) as Record<string, unknown>;
  delete pkgJson.devDependencies;
  delete pkgJson.scripts;
  if (opts.target === "src") {
    pkgJson.bin = { ccqa: "./bin/ccqa.ts" };
    pkgJson.exports = { "./test-helpers": "./src/runtime/test-helpers.ts" };
    delete pkgJson.files;
  }
  await writeFile(
    join(destDir, "package.json"),
    JSON.stringify(pkgJson, null, 2),
    "utf8",
  );
  if (opts.target === "dist") {
    // Keep the published bin/exports/files; ship the built artifact as-is.
    await cp(join(REPO_ROOT, "dist"), join(destDir, "dist"), { recursive: true });
  } else {
    await cp(join(REPO_ROOT, "src"), join(destDir, "src"), { recursive: true });
    await cp(join(REPO_ROOT, "bin"), join(destDir, "bin"), { recursive: true });
  }
}
