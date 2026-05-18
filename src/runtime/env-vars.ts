// Recognise both `$VAR` and `${VAR}`. Variable names follow the conventional
// shell rules (start with a letter or underscore; subsequent chars are
// alphanumeric or underscore). The UPPER-only variant is used for process.env
// resolution; the case-insensitive variant is used wherever block params
// (lowerCamelCase) can also appear.
const ENV_VAR_RE = /\$\{([A-Z_][A-Z0-9_]*)\}|\$([A-Z_][A-Z0-9_]*)/g;
const ANY_VAR_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

/**
 * Replace every `$NAME` / `${NAME}` reference in `value` using `lookup`. When
 * `lookup` returns `undefined`, the original reference text is preserved
 * (callers that want empty-string substitution should wrap with `?? ""`).
 */
export function substituteVars(value: string, lookup: (name: string) => string | undefined): string {
  ANY_VAR_RE.lastIndex = 0;
  return value.replace(ANY_VAR_RE, (match, braced: string | undefined, plain: string | undefined) => {
    const name = braced ?? plain ?? "";
    const replacement = lookup(name);
    return replacement === undefined ? match : replacement;
  });
}

/**
 * Returns true if the value contains at least one `$VAR` or `${VAR}` reference.
 */
export function hasEnvRef(value: string): boolean {
  ENV_VAR_RE.lastIndex = 0;
  return ENV_VAR_RE.test(value);
}

/**
 * Iterate every `${NAME}` / `$NAME` reference name (case-insensitive form)
 * appearing in `value`. Used by callers that want to enumerate refs without
 * also substituting, e.g. the env-scrub map builder. The reference name
 * grammar is the canonical one shared with `substituteVars`.
 */
export function* iterEnvRefNames(value: string): IterableIterator<string> {
  ANY_VAR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ANY_VAR_RE.exec(value)) !== null) {
    const name = m[1] ?? m[2];
    if (name) yield name;
  }
}

/**
 * Resolve every `$VAR` / `${VAR}` reference against the current process env.
 *
 * Missing variables expand to the empty string, mirroring `sh` behaviour.
 * Throwing would force ccqa to be invoked with every var set even for
 * unused blocks, which is more user-hostile than letting the test fail
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
  return refsToJsExpression(value, () => null);
}

/**
 * Generalised version of `envRefsToJsExpression`. Each `$NAME` / `${NAME}`
 * reference in `value` is passed to `nameToExpr(name)` first:
 *
 * - If it returns a string, that string is interpolated as a JS expression
 *   (no quoting / no `?? ""` wrap — the caller decides the shape).
 * - If it returns `null`, the reference is treated as a missing env var
 *   and expands to `process.env.<NAME> ?? ""` (the legacy behaviour).
 *
 * Used by the block codegen path: param names map to `params.<name>`,
 * everything else falls through to `process.env.X ?? ""`.
 */
export function refsToJsExpression(
  value: string,
  nameToExpr: (name: string) => string | null,
): string {
  ANY_VAR_RE.lastIndex = 0;
  if (!ANY_VAR_RE.test(value)) {
    return JSON.stringify(value);
  }

  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\$\{/g, (_match, offset: number, source: string) => {
      // Preserve `${` only when it opens a well-formed env / param ref —
      // otherwise escape it so the resulting template literal stays valid.
      const probe = new RegExp(ANY_VAR_RE.source, "g");
      let m: RegExpExecArray | null;
      while ((m = probe.exec(source)) !== null) {
        if (m.index === offset) return "${";
      }
      return "\\${";
    });

  ANY_VAR_RE.lastIndex = 0;
  const replaced = escaped.replace(ANY_VAR_RE, (_match, braced: string | undefined, plain: string | undefined) => {
    const name = braced ?? plain ?? "";
    const expr = nameToExpr(name);
    return expr !== null ? `\${${expr}}` : `\${process.env.${name} ?? ""}`;
  });

  return `\`${replaced}\``;
}
