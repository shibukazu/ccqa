/**
 * Variables that carry a credential the Claude Code process can use on its
 * own, with no login on the host: an API key, a gateway bearer token, or a
 * subscription token from `claude setup-token`.
 */
export const CREDENTIAL_ENV_KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"] as const;

/**
 * Standard Claude Code environment variables that select the API endpoint and
 * credentials. ccqa forwards whichever of these are set to the underlying
 * Claude Code process; it does not read or interpret their values.
 *
 * - `ANTHROPIC_BASE_URL`      — the API endpoint to send requests to.
 * - `ANTHROPIC_AUTH_TOKEN`    — sent as `Authorization: Bearer <token>`.
 * - `ANTHROPIC_API_KEY`       — API key, when used instead of a token.
 * - `ANTHROPIC_CUSTOM_HEADERS` — extra request headers.
 * - `CLAUDE_CODE_OAUTH_TOKEN` — long-lived subscription token from
 *   `claude setup-token`, the headless-CI counterpart of a login.
 */
export const ENDPOINT_ENV_KEYS = ["ANTHROPIC_BASE_URL", "ANTHROPIC_CUSTOM_HEADERS", ...CREDENTIAL_ENV_KEYS] as const;
