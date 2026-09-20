import { pathToFileURL } from "node:url";
import { ZodError } from "zod";
import { errMessage, RunUsageError } from "../run/errors.ts";
import { caseFromDocument } from "./case.ts";
import { CaseSchema } from "./case-schema.ts";
import type { Case, CaseSource } from "./contract.ts";
import type { CaseAdapter, CaseRead } from "./source.ts";

/**
 * The project's own case reader, loaded from the module `targets.<id>.cases`
 * names.
 *
 * ccqa imports it and validates everything it returns. Nothing about the
 * project's format reaches ccqa — not a heading, not a bullet character, not a
 * punctuation mark — which is the point: a format-specific accommodation has
 * nowhere here to land.
 */

/** Extensions Node can import on its own, on every version ccqa supports. */
const LOADABLE = [".mjs", ".js", ".cjs"];

export function moduleCaseSource(modulePath: string, cwd: string, targetId: string): CaseAdapter {
  // Every refusal names the key and the file it resolved to: a path read out
  // of config is the one thing the reader of the message cannot see.
  const at = `targets.${targetId}.cases (${modulePath})`;
  // Opened once, on the first question asked of it. A command that never
  // reaches a case (`--help`, a config error) must not pay to import it, and
  // two commands must not see two different readings of the same directory.
  let opened: Promise<CaseSource> | null = null;
  const source = (): Promise<CaseSource> => (opened ??= open(modulePath, at, cwd));

  return {
    async list(): Promise<string[]> {
      const listed = await (await source()).list();
      if (!Array.isArray(listed) || listed.some((id) => typeof id !== "string")) {
        throw new RunUsageError(`${at}: list() must return an array of case ids`);
      }
      // Sorted and de-duplicated here rather than asked of the reader: a
      // repeated id would run and report one case twice, and no reader should
      // have to know that.
      return [...new Set(listed)].sort();
    },
    // The module owns both spellings of a case, so ccqa hands the argument
    // over as written and takes the `id` that comes back as the answer.
    idFor: (ref) => ref,
    async read(ref): Promise<CaseRead> {
      const absent = (error: string): CaseRead => ({ id: ref, case: null, document: null, error });
      let loaded: Case;
      try {
        loaded = CaseSchema.parse(await (await source()).load(ref));
      } catch (err) {
        if (err instanceof RunUsageError) throw err;
        if (err instanceof ZodError) {
          return absent(`${at}: load(${JSON.stringify(ref)}) returned ${describe(err)}`);
        }
        // The reader's own words: it already says which file it could not
        // read, and re-wrapping would bury that.
        return absent(errMessage(err));
      }
      return {
        id: loaded.id,
        case: caseFromDocument(loaded, cwd),
        document: { path: loaded.path, text: loaded.text },
        error: null,
      };
    },
  };
}

async function open(modulePath: string, at: string, cwd: string): Promise<CaseSource> {
  // Checked before the import rather than after it, so the answer does not
  // depend on which Node the CLI happens to run under: a `.ts` reader works
  // under some and not others, and "sometimes" is the worst contract to ship.
  if (!LOADABLE.some((ext) => modulePath.endsWith(ext))) {
    throw new RunUsageError(`${at}: cannot be loaded — ${notJavaScript()}`);
  }
  let mod: { default?: unknown };
  try {
    mod = (await import(pathToFileURL(modulePath).href)) as { default?: unknown };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    const hint = code === "ERR_UNKNOWN_FILE_EXTENSION" ? ` ${notJavaScript()}` : "";
    throw new RunUsageError(`${at}: could not be loaded — ${errMessage(err)}${hint}`);
  }
  if (typeof mod.default !== "function") {
    throw new RunUsageError(
      `${at}: must default-export a function taking { cwd } and returning ` +
        `{ list, load } — see https://github.com/shibukazu/ccqa/blob/main/docs/targets.md`,
    );
  }
  const opened = (await (mod.default as (ctx: { cwd: string }) => unknown)({ cwd })) as unknown;
  if (
    typeof opened !== "object" ||
    opened === null ||
    typeof (opened as CaseSource).list !== "function" ||
    typeof (opened as CaseSource).load !== "function"
  ) {
    throw new RunUsageError(`${at}: the default export must return an object with list() and load()`);
  }
  return opened as CaseSource;
}

/**
 * The mistake that is actually likely, in the terms it is made in. Consumers
 * write TypeScript, and an extension error alone reads as a broken install.
 */
function notJavaScript(): string {
  return (
    `a case source is plain JavaScript (${LOADABLE.join(", ")}): ccqa imports it with no loader, ` +
    `so a TypeScript file cannot be read. Write it as .mjs — \`// @ts-check\` plus ` +
    `\`@type {import("ccqa/case-source").CaseSourceFactory}\` type-checks it without a build step — ` +
    `or point \`cases\` at compiled output.`
  );
}

/** A zod rejection as one line per offending field. */
function describe(err: ZodError): string {
  const issues = err.issues.map((issue) => {
    const path = issue.path.join(".") || "(the case)";
    return `${path}: ${issue.message}`;
  });
  return `a value that is not a case — ${issues.join("; ")}`;
}
