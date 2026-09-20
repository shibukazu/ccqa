import { isAbsolute, resolve } from "node:path";
import type { ProjectConfig, TargetConfig } from "../config/project-config.ts";
import type { TestCase } from "./case.ts";
import { moduleCaseSource } from "./module-source.ts";
import { RunUsageError } from "../run/errors.ts";
import type { CaseAdapter, CaseRead } from "./source.ts";
import { specCaseSource } from "./spec-source.ts";

/** A target that reads its cases through a module this project owns. */
export interface CaseTarget {
  id: string;
  targetConfig: TargetConfig;
  /** `targets.<id>.cases` as written, for messages. */
  module: string;
  /** The same, resolved against the project root — the module's identity. */
  modulePath: string;
}

/**
 * The target whose cases live in the project, when that is what we resolve to.
 *
 * Which of the two places a project keeps its cases in is settled by its
 * target, not by guessing at an argument's shape: a target that declares a
 * case source of its own reads the project's documents, and one that does not
 * reads ccqa's `spec.yaml`.
 */
export function caseTargetFor(
  config: ProjectConfig,
  cwd: string,
  targetOverride?: string,
): CaseTarget | null {
  const id = targetOverride ?? config.defaultTarget;
  const targetConfig = config.targets[id];
  const module = targetConfig?.cases;
  if (targetConfig === undefined || module === undefined) return null;
  const modulePath = isAbsolute(module) ? module : resolve(cwd, module);
  return { id, targetConfig, module, modulePath };
}

/**
 * The one door to this project's test cases.
 *
 * Every feature — generate, record, run, audit, select, evidence,
 * perspectives — reaches a case through here, so a format-specific
 * accommodation has nowhere in ccqa to land and a call site cannot quietly
 * read one kind of case behind the reader's back.
 */
export interface CaseReader {
  /** Every case id this project holds, sorted. Includes disabled cases. */
  list(): Promise<string[]>;
  /**
   * One case, by id or by the path an argument named. Raises a usage error
   * when there is no such case, or when it cannot be acted on.
   */
  load(ref: string): Promise<TestCase>;
  /** The same, reporting an unreadable case as an outcome rather than raising. */
  read(ref: string): Promise<CaseRead>;
  /** The target whose cases these are; null when they are ccqa's own `spec.yaml`. */
  target: CaseTarget | null;
}

export interface OpenCaseReaderOptions {
  /** CLI `--target`: read the cases that target owns instead of the default's. */
  targetOverride?: string;
}

export function openCaseReader(
  config: ProjectConfig,
  cwd: string,
  opts: OpenCaseReaderOptions = {},
): CaseReader {
  const target = caseTargetFor(config, cwd, opts.targetOverride);
  const source: CaseAdapter = target
    ? moduleCaseSource(target.modulePath, cwd, target.id)
    : specCaseSource(cwd);
  // One read per case per reader. A command asks for the same case twice —
  // the audit enumerates and then reads, the run selects and then executes —
  // and a second read would show a mid-command edit rather than what the
  // command decided on.
  const byId = new Map<string, Promise<CaseRead>>();
  const read = (ref: string): Promise<CaseRead> => {
    const key = source.idFor(ref);
    const cached = byId.get(key);
    if (cached !== undefined) return cached;
    const pending = source.read(key);
    byId.set(key, pending);
    // Filed again under the id the source answered with, so naming a case by
    // its file and then by its id is one read rather than two. The rejection
    // is the caller's to see; swallowing it here only keeps it unhandled.
    void pending.then(
      (result) => {
        if (!byId.has(result.id)) byId.set(result.id, pending);
      },
      () => {},
    );
    return pending;
  };
  return {
    list: () => source.list(),
    read,
    async load(ref): Promise<TestCase> {
      const result = await read(ref);
      // A mistyped case id is the operator's slip, not a crash: every command
      // that resolves a `<case>` argument maps this to `[error] …` and exit 2
      // (`withUsageErrors`), so the boundary is here rather than in each of
      // them.
      if (result.case === null) {
        throw new RunUsageError(result.error ?? `no test case named "${ref}"`);
      }
      // A case a command was asked to act on has to be whole. Listing it is
      // another matter — see `TestCase.blocked`.
      if (result.case.blocked !== null) throw new RunUsageError(result.case.blocked);
      return result.case;
    },
    target,
  };
}
