// Recognise both `$VAR` and `${VAR}`. Variable names follow the conventional
// shell rules (start with a letter or underscore; subsequent chars are
// alphanumeric or underscore).
const ENV_VAR_RE = /\$\{([A-Z_][A-Z0-9_]*)\}|\$([A-Z_][A-Z0-9_]*)/g;

/**
 * Returns true if the value contains at least one `$VAR` or `${VAR}` reference.
 */
export function hasEnvRef(value: string): boolean {
  ENV_VAR_RE.lastIndex = 0;
  return ENV_VAR_RE.test(value);
}

/**
 * Resolve every `$VAR` / `${VAR}` reference against the current process env.
 *
 * Missing variables expand to the empty string, mirroring `sh` behaviour.
 * Throwing would force ccqa to be invoked with every var set even for
 * unused setups, which is more user-hostile than letting the test fail
 * downstream with a clearer message ("login form rejected: empty password").
 */
export function resolveEnvRefs(value: string): string {
  return value.replace(ENV_VAR_RE, (_, braced: string | undefined, plain: string | undefined) => {
    const name = braced ?? plain ?? "";
    return process.env[name] ?? "";
  });
}

/**
 * Embed `$VAR` / `${VAR}` as a JS template-literal expression that reads
 * `process.env.VAR ?? ""` at runtime. Used by `ccqa generate` so the test
 * script never bakes in the secret value.
 *
 * Returns a JavaScript string-literal expression (template literal when env
 * refs are present, plain string literal otherwise).
 *
 * Examples:
 *   "${PASSWORD}"             -> '`${process.env.PASSWORD ?? ""}`'
 *   "user-${SUFFIX}@x.com"    -> '`user-${process.env.SUFFIX ?? ""}@x.com`'
 *   "literal value"           -> '"literal value"'
 */
export function envRefsToJsExpression(value: string): string {
  if (!hasEnvRef(value)) {
    return JSON.stringify(value);
  }

  // Build a template literal. Escape backticks, backslashes, and `${` that
  // aren't ours so the resulting string is a valid template literal.
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\$\{/g, (match, offset, source) => {
      // Keep `${` only when it's an env-ref we're about to substitute.
      ENV_VAR_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = ENV_VAR_RE.exec(source)) !== null) {
        if (m.index === offset) return "${";
      }
      return "\\${";
    });
  ENV_VAR_RE.lastIndex = 0;

  const replaced = escaped.replace(ENV_VAR_RE, (_, braced: string | undefined, plain: string | undefined) => {
    const name = braced ?? plain ?? "";
    return `\${process.env.${name} ?? ""}`;
  });

  return `\`${replaced}\``;
}
