import { listAllSpecsWithSpecFile, specKey, type SpecRef } from "../store/index.ts";
import type { SerialGroups } from "../config/project-config.ts";
import { RunUsageError } from "./errors.ts";

/**
 * Which serial groups a spec belongs to. Passed to whatever schedules specs
 * rather than copied onto them, so the config stays the only place the answer
 * comes from.
 */
export type GroupLookup = (ref: SpecRef) => readonly string[];

const NO_GROUPS: GroupLookup = () => [];

/**
 * Invert `serialGroups` into a per-spec lookup, checking every member names a
 * spec that exists.
 *
 * The check is the point of putting the groups here: a member that resolves to
 * nothing is a typo, and left unchecked it would quietly shrink the group
 * instead of failing. Validated against every spec in the project, not the
 * selection, so a group whose members this run did not select is still read as
 * correct.
 */
export async function resolveSerialGroups(
  groups: SerialGroups,
  cwd: string,
): Promise<GroupLookup> {
  const names = Object.keys(groups);
  if (names.length === 0) return NO_GROUPS;

  const known = new Set((await listAllSpecsWithSpecFile(cwd)).map(specKey));
  const bySpec = new Map<string, string[]>();
  for (const name of names) {
    for (const member of groups[name] ?? []) {
      if (!known.has(member)) {
        throw new RunUsageError(
          `serialGroups.${name} lists "${member}", which is not a spec in this project`,
        );
      }
      bySpec.set(member, [...(bySpec.get(member) ?? []), name]);
    }
  }
  return (ref) => bySpec.get(specKey(ref)) ?? [];
}
