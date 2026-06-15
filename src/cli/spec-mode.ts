import { tryReadSpecFile, type SpecRef } from "../store/index.ts";
import { parseTestSpec } from "../spec/parser.ts";
import { DEFAULT_SPEC_MODE, type SpecMode } from "../spec/yaml-schema.ts";

export type SpecWithMode = SpecRef & { mode: SpecMode };

/**
 * Read each spec.yaml and resolve its execution mode. Spec-declared `mode:`
 * wins; otherwise `DEFAULT_SPEC_MODE`. Unreadable/unparseable YAML falls back
 * to the default so the per-mode runner surfaces the real error itself.
 */
export async function resolveSpecsModes(
  specs: readonly SpecRef[],
  cwd: string,
): Promise<SpecWithMode[]> {
  return Promise.all(specs.map(async (s) => ({ ...s, mode: await resolveOne(s, cwd) })));
}

async function resolveOne(spec: SpecRef, cwd: string): Promise<SpecMode> {
  const yaml = await tryReadSpecFile(spec.featureName, spec.specName, cwd);
  if (yaml === null) return DEFAULT_SPEC_MODE;
  try {
    return parseTestSpec(yaml).mode ?? DEFAULT_SPEC_MODE;
  } catch {
    return DEFAULT_SPEC_MODE;
  }
}
