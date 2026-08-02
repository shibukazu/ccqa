// The API surface in one place: login is open, everything else sits behind
// the session guard.

import { sendJson } from "./http.mjs";
import { handleAuth, isAuthorized } from "./routes/auth.mjs";
import { handleTasks } from "./routes/tasks.mjs";

export async function handleApi(req, res, url) {
  if (await handleAuth(req, res, url)) return;
  if (!isAuthorized(req)) {
    sendJson(res, 401, { error: "Not signed in" });
    return;
  }
  if (await handleTasks(req, res, url)) return;
  sendJson(res, 404, { error: "No such endpoint" });
}
