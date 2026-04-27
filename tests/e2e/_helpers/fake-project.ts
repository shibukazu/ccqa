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
  opts: { linkCcqa?: boolean } = {},
): Promise<FakeProject> {
  const src = join(FIXTURES_ROOT, fixtureName);
  const cwd = await mkdtemp(join(tmpdir(), `ccqa-e2e-${fixtureName}-`));
  await cp(src, cwd, { recursive: true });

  if (opts.linkCcqa) {
    const nm = join(cwd, "node_modules");
    await mkdir(nm, { recursive: true });
    await materializeCcqaPackage(join(nm, "ccqa"));
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
// We copy bin/ + src/ and rewrite package.json's bin/exports to point at
// those source files (not the dist/ paths the real published manifest
// uses). This lets the E2E suite exercise the CLI without requiring a
// fresh `pnpm build` to land dist/ first. The install-smoke test is the
// one scenario that validates the real dist/ distribution path.
async function materializeCcqaPackage(destDir: string): Promise<void> {
  await mkdir(destDir, { recursive: true });
  const pkgJson = JSON.parse(
    await readFile(join(REPO_ROOT, "package.json"), "utf8"),
  ) as Record<string, unknown>;
  delete pkgJson.devDependencies;
  delete pkgJson.scripts;
  // Redirect to the copied source tree so fixture specs that import
  // "ccqa/test-helpers" resolve to src/runtime/test-helpers.ts, which
  // Node can strip at runtime via --experimental-strip-types.
  pkgJson.bin = { ccqa: "./bin/ccqa.ts" };
  pkgJson.exports = { "./test-helpers": "./src/runtime/test-helpers.ts" };
  delete pkgJson.files;
  await writeFile(
    join(destDir, "package.json"),
    JSON.stringify(pkgJson, null, 2),
    "utf8",
  );
  await cp(join(REPO_ROOT, "src"), join(destDir, "src"), { recursive: true });
  await cp(join(REPO_ROOT, "bin"), join(destDir, "bin"), { recursive: true });
}
