// Fetch layer shared by every view. Keeps the session token so callers never
// touch auth headers themselves.

let token = null;

export async function apiLogin(email, password) {
  const res = await request("POST", "/api/login", { email, password });
  token = res.token;
}

export async function apiListTasks() {
  const res = await request("GET", "/api/tasks");
  return res.tasks;
}

export async function apiAddTask(title) {
  const res = await request("POST", "/api/tasks", { title });
  return res.task;
}

export async function apiToggleTask(id, done) {
  const res = await request("PATCH", `/api/tasks/${id}`, { done });
  return res.task;
}

async function request(method, path, body) {
  const headers = { "content-type": "application/json" };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  const res = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await res.json();
  if (!res.ok) throw new Error(payload.error ?? `request failed (${res.status})`);
  return payload;
}
