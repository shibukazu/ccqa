import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseDotenv } from "../runtime/profile-env.ts";
import * as log from "./logger.ts";

/**
 * The project's own variable files, loaded into `process.env` before anything
 * resolves a `${VAR}`.
 *
 * A repository that already runs tests has these somewhere — the file its test
 * command sources. Pointing ccqa at it beats copying those values into a
 * second place that then drifts, and it is why this is a list of paths rather
 * than a store of its own.
 *
 * A named file that is not there is an error, not a shrug: recording against
 * variables that silently resolved to nothing bakes whatever the browser
 * happened to show into the route, and that is discovered days later in a
 * different environment.
 */
export async function loadEnvFiles(files: readonly string[], cwd: string): Promise<void> {
  for (const file of files) {
    const path = join(cwd, file);
    const content = await readFile(path, "utf8").catch((err: NodeJS.ErrnoException) => {
      throw new Error(
        err.code === "ENOENT"
          ? `envFiles names ${file}, which is not there (resolved to ${path})`
          : `could not read ${file}: ${err.message}`,
      );
    });
    const values = parseDotenv(content);
    // An explicit export for this one run wins over the file, the same
    // precedence `.env` already has — someone overriding a variable on the
    // command line means it.
    for (const [name, value] of Object.entries(values)) {
      if (process.env[name] === undefined) process.env[name] = value;
    }
    log.meta("env", `${file} (${Object.keys(values).length} var(s))`);
  }
}
