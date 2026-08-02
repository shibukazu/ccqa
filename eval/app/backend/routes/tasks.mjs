// Task routes: list, add, toggle. Each handler returns true once it has
// answered; false lets the router fall through to its 404.

import { readBody, sendJson } from "../http.mjs";
import { addTask, findTask, listTasks } from "../store.mjs";
import { validDone, validTitle } from "../validate.mjs";

export async function handleTasks(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/tasks") {
    sendJson(res, 200, { tasks: listTasks() });
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/tasks") {
    const body = await readBody(req);
    const title = validTitle(body);
    if (title === null) {
      sendJson(res, 400, { error: "Title is required" });
      return true;
    }
    sendJson(res, 201, { task: addTask(title) });
    return true;
  }
  const toggle = url.pathname.match(/^\/api\/tasks\/(\d+)$/);
  if (req.method === "PATCH" && toggle) {
    const task = findTask(Number(toggle[1]));
    if (!task) {
      sendJson(res, 404, { error: "No such task" });
      return true;
    }
    const body = await readBody(req);
    const done = validDone(body);
    if (done !== null) task.done = done;
    sendJson(res, 200, { task });
    return true;
  }
  return false;
}
