// Login and the session guard. A single in-memory token: signing in again
// replaces it, which is all a single-account app needs.

import { readBody, sendJson } from "../http.mjs";

const ACCOUNT = {
  email: process.env.APP_EMAIL ?? "user@example.com",
  password: process.env.APP_PASSWORD ?? "secret123",
};

let sessionToken = null;

/** Handles POST /api/login; returns false for anything else. */
export async function handleAuth(req, res, url) {
  if (req.method !== "POST" || url.pathname !== "/api/login") return false;
  const body = await readBody(req);
  if (body.email === ACCOUNT.email && body.password === ACCOUNT.password) {
    sessionToken = `t-${Date.now()}`;
    sendJson(res, 200, { token: sessionToken });
  } else {
    sendJson(res, 401, { error: "Wrong email or password" });
  }
  return true;
}

export function isAuthorized(req) {
  const header = req.headers.authorization ?? "";
  return sessionToken !== null && header === `Bearer ${sessionToken}`;
}
