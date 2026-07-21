import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/**
 * The agent SDK launches Claude through a native `claude` binary that ships in
 * a per-platform package (`@anthropic-ai/claude-agent-sdk-<platform>-<cpu>`),
 * declared as an *optional* dependency of the SDK. Optional means a consumer's
 * lockfile can omit it without any install-time error — and then every Claude
 * call fails at runtime with a message that never reaches our logs. Resolving
 * the package up front lets us say so once, in a line that names the fix.
 *
 * ccqa's own package.json repeats these packages in `optionalDependencies` for
 * the same reason: a second declaration gives the resolver another chance to
 * record them. Keep that list's version range in step with the SDK's.
 */
export function nativeBinaryPackage(
  platform: string = process.platform,
  arch: string = process.arch,
  musl: boolean = isMusl(platform),
): string {
  const cpu = arch === "arm64" ? "arm64" : "x64";
  const suffix = platform === "linux" && musl ? "-musl" : "";
  return `@anthropic-ai/claude-agent-sdk-${platform}-${cpu}${suffix}`;
}

/**
 * musl builds (Alpine and friends) need their own binary. Node doesn't expose
 * the libc flavour directly; the absence of `glibcVersionRuntime` in the
 * process report is the usual proxy.
 */
function isMusl(platform: string): boolean {
  if (platform !== "linux") return false;
  const report = process.report?.getReport?.() as
    | { header?: { glibcVersionRuntime?: string } }
    | undefined;
  return !report?.header?.glibcVersionRuntime;
}

/**
 * Name of the platform package this host needs, or `null` when it resolves.
 * The per-platform packages have no `exports`, so the manifest is reachable.
 */
export function missingNativeBinaryPackage(
  resolve: (id: string) => unknown = require.resolve,
): string | null {
  const pkg = nativeBinaryPackage();
  try {
    resolve(`${pkg}/package.json`);
    return null;
  } catch {
    return pkg;
  }
}

/** Advice shown when the binary is absent — the package name plus how to fix it. */
export function missingNativeBinaryMessage(pkg: string): string {
  return (
    `${pkg} is not installed. The Claude Agent SDK needs it to start Claude on this ` +
    `platform, so every Claude-backed command (run in live mode, drift, diagnose) will fail. ` +
    `It ships as an optional dependency of the SDK, which a lockfile can drop silently: ` +
    `reinstall without omitting optional dependencies, or add it to your project as a direct ` +
    `dependency pinned to the same version as @anthropic-ai/claude-agent-sdk.`
  );
}
