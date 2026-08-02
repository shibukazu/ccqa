// Tiny task-list app server: static files from public/ plus a JSON API.
// No dependencies, no build step — `node server.mjs` is the whole deal.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const PUBLIC_DIR = fileURLToPath(new URL("./public", import.meta.url));
const PORT = Number(process.env.PORT ?? 4173);

const ACCOUNT = {
  email: process.env.APP_EMAIL ?? "user@example.com",
  password: process.env.APP_PASSWORD ?? "secret123",
};

/** @type {Array<{ id: number, title: string, done: boolean }>} */
let tasks = [];
let nextId = 1;
let sessionToken = null;

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

async function handleApi(req, res, url) {
  if (req.method === "POST" && url.pathname === "/api/login") {
    const body = await readBody(req);
    if (body.email === ACCOUNT.email && body.password === ACCOUNT.password) {
      sessionToken = `t-${Date.now()}`;
      sendJson(res, 200, { token: sessionToken });
    } else {
      sendJson(res, 401, { error: "Wrong email or password" });
    }
    return;
  }

  if (!isAuthorized(req)) {
    sendJson(res, 401, { error: "Not signed in" });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/tasks") {
    sendJson(res, 200, { tasks });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/tasks") {
    const body = await readBody(req);
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (!title) {
      sendJson(res, 400, { error: "Title is required" });
      return;
    }
    const task = { id: nextId++, title, done: false };
    tasks.push(task);
    sendJson(res, 201, { task });
    return;
  }
  const toggle = url.pathname.match(/^\/api\/tasks\/(\d+)$/);
  if (req.method === "PATCH" && toggle) {
    const task = tasks.find((t) => t.id === Number(toggle[1]));
    if (!task) {
      sendJson(res, 404, { error: "No such task" });
      return;
    }
    const body = await readBody(req);
    if (typeof body.done === "boolean") task.done = body.done;
    sendJson(res, 200, { task });
    return;
  }
  sendJson(res, 404, { error: "No such endpoint" });
}

function isAuthorized(req) {
  const header = req.headers.authorization ?? "";
  return sessionToken !== null && header === `Bearer ${sessionToken}`;
}

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

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      try {
        resolve(raw.length === 0 ? {} : JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

server.listen(PORT, () => {
  console.log(`task app listening on http://localhost:${PORT}`);
});
