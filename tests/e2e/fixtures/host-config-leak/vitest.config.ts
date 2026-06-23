// Loading this config should crash vitest.
// ccqa run MUST NOT pick it up — it passes --config <bundled> to isolate.
throw new Error("host config leaked into ccqa run");

// Unreachable export to keep TS happy if the throw is ever removed.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export default {};
