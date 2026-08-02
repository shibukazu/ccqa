// Boot and static serving. Everything under /api/ is the backend's
// (backend/router.mjs). No dependencies, no build step — `node server.mjs`
// is still the whole deal.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { sendJson } from "./backend/http.mjs";
import { handleApi } from "./backend/router.mjs";

const PUBLIC_DIR = fileURLToPath(new URL("./public", import.meta.url));
const PORT = Number(process.env.PORT ?? 4173);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

// Pretty routes for the pages; anything else resolves as a file under public/.
const PAGES = {
  "/": "index.html",
  "/help": "help.html",
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
    } else {
      await serveStatic(res, url.pathname);
    }
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : "internal error" });
  }
});

async function serveStatic(res, pathname) {
  const rel = PAGES[pathname] ?? pathname.slice(1);
  const path = normalize(join(PUBLIC_DIR, rel));
  if (!path.startsWith(PUBLIC_DIR)) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }
  try {
    const body = await readFile(path);
    res.writeHead(200, { "content-type": MIME[extname(path)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    sendJson(res, 404, { error: "Not found" });
  }
}

server.listen(PORT, () => {
  console.log(`task app listening on http://localhost:${PORT}`);
});
