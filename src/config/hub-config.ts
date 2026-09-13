import type { HubConfig } from "./project-config.ts";

/**
 * The project's own `hub:` block, once something has read the config.
 *
 * A registry rather than a parameter because the hub connection is resolved
 * from eight call sites and only some of them have a project at all. It lives
 * here rather than beside the resolver so that the config module can fill it
 * without the two importing each other.
 */
let configured: HubConfig | null = null;

export function rememberHubConfig(hub: HubConfig | undefined): void {
  configured = hub ?? null;
}

export function configuredHub(): HubConfig | null {
  return configured;
}
