import { specKey, type SpecRef } from "../store/index.ts";
import type { TestCase } from "../cases/case.ts";
import type { CaseReader } from "../cases/reader.ts";
import { DEFAULT_SPEC_MODE, type SpecMode } from "../spec/yaml-schema.ts";

/**
 * One case as read. `case` is null both when its document is absent and when
 * it would not parse; `error` separates the two, because everything read off
 * the document (`mode:`) silently falls back to its default when parsing
 * fails, which must not look like a case that declares nothing.
 */
export interface CatalogEntry {
  case: TestCase | null;
  /**
   * The document verbatim, null when there is none. Kept beside the parse
   * because the report row and the failure classifier want what was written,
   * and re-reading it later would show a mid-run edit rather than what ran.
   */
  yaml: string | null;
  error: string | null;
}

/** Every selected case, read once for the whole run. */
export type SpecCatalog = ReadonlyMap<string, CatalogEntry>;

export async function readSpecs(
  refs: readonly SpecRef[],
  reader: CaseReader,
): Promise<SpecCatalog> {
  const entries = await Promise.all(
    refs.map(async (ref): Promise<readonly [string, CatalogEntry]> => {
      const read = await reader.read(specKey(ref));
      return [
        specKey(ref),
        {
          case: read.case,
          yaml: read.document?.text ?? null,
          // An absent document is not an error here: the run surfaces that
          // itself, with the command that would create one.
          error: read.document === null ? null : read.error,
        },
      ];
    }),
  );
  return new Map(entries);
}

export type SpecWithMode = SpecRef & { mode: SpecMode };

/** Case-declared `mode:` wins; otherwise `DEFAULT_SPEC_MODE`. */
export function resolveSpecsModes(specs: readonly SpecRef[], catalog: SpecCatalog): SpecWithMode[] {
  return specs.map((s) => ({
    ...s,
    mode: catalog.get(specKey(s))?.case?.mode ?? DEFAULT_SPEC_MODE,
  }));
}
