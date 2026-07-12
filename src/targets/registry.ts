import { AGENT_BROWSER_TARGET, type TestSpec } from "../spec/yaml-schema.ts";
import type { ProjectConfig } from "../config/project-config.ts";
import type { TargetPlugin } from "./types.ts";
import { agentBrowserTarget } from "./agent-browser/index.ts";
import { playwrightTarget } from "./playwright/index.ts";
import { runnTarget } from "./runn/index.ts";

/**
 * Static registry of generation targets. Adding a target means registering
 * its plugin in this list — the CLI dispatches through `resolveTarget` and
 * carries no per-target branches.
 */
const REGISTERED_TARGETS: ReadonlyMap<string, TargetPlugin> = new Map(
  [agentBrowserTarget, playwrightTarget, runnTarget].map((p) => [p.id, p]),
);

/**
 * Resolve the plugin a spec generates through. Precedence: spec `target:` >
 * config `defaultTarget` > "agent-browser" (the config schema's own default,
 * so a missing `.ccqa/config.yaml` lands there).
 *
 * Also enforces the post-resolution `mode:`/`session:` check the spec schema
 * cannot: those fields are agent-browser-only, but when `target:` is omitted
 * the schema can't see what the spec resolves to and passes them through
 * (see TestSpecSchema's JSDoc).
 */
export function resolveTarget(spec: TestSpec, config: ProjectConfig): TargetPlugin {
  return resolveTargetFrom(spec, config, REGISTERED_TARGETS);
}

/**
 * Resolve a CLI `--target` override. Unlike `resolveTarget`, the requested id
 * wins over both the spec and the config, so one recording can be emitted
 * through several targets (`ccqa generate <spec> --target playwright`). The
 * agent-browser-only `mode:`/`session:` fields still gate the override: a
 * live spec has no recording to emit from, and a session-restored recording
 * only replays under agent-browser.
 */
export function resolveTargetOverride(spec: TestSpec, id: string): TargetPlugin {
  const plugin = REGISTERED_TARGETS.get(id);
  if (!plugin) {
    throw new Error(
      `unknown target "${id}" (from --target) — registered targets: ${[...REGISTERED_TARGETS.keys()].join(", ")}`,
    );
  }
  if (plugin.id !== AGENT_BROWSER_TARGET) {
    for (const key of ["mode", "session"] as const) {
      if (spec[key] !== undefined) {
        throw new Error(
          `\`${key}\` only applies to the agent-browser target — this spec cannot be generated with --target ${id}`,
        );
      }
    }
  }
  return plugin;
}

/** Testable core of `resolveTarget` — tests inject a registry with fake targets. */
export function resolveTargetFrom(
  spec: TestSpec,
  config: ProjectConfig,
  registry: ReadonlyMap<string, TargetPlugin>,
): TargetPlugin {
  const id = spec.target ?? config.defaultTarget;
  const plugin = registry.get(id);
  if (!plugin) {
    const source =
      spec.target !== undefined ? "spec.yaml `target:`" : "`defaultTarget` in .ccqa/config.yaml";
    throw new Error(
      `unknown target "${id}" (from ${source}) — registered targets: ${[...registry.keys()].join(", ")}`,
    );
  }
  if (plugin.id !== AGENT_BROWSER_TARGET) {
    for (const key of ["mode", "session"] as const) {
      if (spec[key] !== undefined) {
        const via = spec.target === undefined ? " via the project config's `defaultTarget`" : "";
        throw new Error(
          `\`${key}\` only applies to the agent-browser target, but this spec resolves to "${id}"${via} — ` +
            `remove \`${key}\` or set \`target: ${AGENT_BROWSER_TARGET}\` in the spec`,
        );
      }
    }
  }
  return plugin;
}
