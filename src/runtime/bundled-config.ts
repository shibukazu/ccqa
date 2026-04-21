import { accessSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Resolves the absolute path to the bundled vitest config that `ccqa run`
// hands to vitest via --config. Emitted as .js by tsdown, so production
// builds find dist/runtime/vitest.config.js directly. Dev mode (running
// the CLI from source via `node --experimental-strip-types ./bin/ccqa.ts`)
// has no .js next to the .ts source, so we probe .js first and fall back
// to .ts when running from source.
export function bundledVitestConfigPath(): string {
  const jsPath = fileURLToPath(
    new URL("./vitest.config.js", import.meta.url),
  );
  try {
    accessSync(jsPath);
    return jsPath;
  } catch {
    return fileURLToPath(new URL("./vitest.config.ts", import.meta.url));
  }
}
