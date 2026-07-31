import { specKey, tryReadSpecFile, type SpecRef } from "../store/index.ts";
import { parseTestSpec } from "../spec/parser.ts";
import { DEFAULT_SPEC_MODE, type SpecMode, type TestSpec } from "../spec/yaml-schema.ts";
import { errMessage } from "./errors.ts";

/**
 * One spec.yaml as read. `spec` is null both when the file is absent and when
 * it would not parse; `error` separates the two, because everything read off
 * the file (`mode:`) silently falls back to its default when
 * parsing fails, which must not look like a spec that declares nothing.
 */
export interface CatalogEntry {
  spec: TestSpec | null;
  error: string | null;
}

/** Every selected spec.yaml, read and parsed once for the whole run. */
export type SpecCatalog = ReadonlyMap<string, CatalogEntry>;

export async function readSpecs(refs: readonly SpecRef[], cwd: string): Promise<SpecCatalog> {
  const entries = await Promise.all(
    refs.map(async (ref): Promise<readonly [string, CatalogEntry]> => {
      const yaml = await tryReadSpecFile(ref.featureName, ref.specName, cwd);
      if (yaml === null) return [specKey(ref), { spec: null, error: null }];
      try {
        return [specKey(ref), { spec: parseTestSpec(yaml), error: null }];
      } catch (err) {
        return [specKey(ref), { spec: null, error: errMessage(err) }];
      }
    }),
  );
  return new Map(entries);
}

export type SpecWithMode = SpecRef & { mode: SpecMode };

/** Spec-declared `mode:` wins; otherwise `DEFAULT_SPEC_MODE`. */
export function resolveSpecsModes(specs: readonly SpecRef[], catalog: SpecCatalog): SpecWithMode[] {
  return specs.map((s) => ({
    ...s,
    mode: catalog.get(specKey(s))?.spec?.mode ?? DEFAULT_SPEC_MODE,
  }));
}
