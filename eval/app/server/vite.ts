import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Express } from "express";

const webRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "web");

/**
 * Serve the frontend through Vite in middleware mode: one process, instant
 * HMR in development, and every non-/api request falls through to the SPA.
 */
export async function attachFrontend(app: Express): Promise<void> {
  const { createServer } = await import("vite");
  const vite = await createServer({
    root: webRoot,
    configFile: path.join(webRoot, "vite.config.ts"),
    server: { middlewareMode: true },
    appType: "spa",
  });
  app.use(vite.middlewares);
}
