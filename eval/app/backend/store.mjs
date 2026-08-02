// In-memory data layer. State lives for the process lifetime and resets on
// restart; the routes go through these functions, never the array itself.

/** @type {Array<{ id: number, title: string, done: boolean }>} */
let tasks = [];
let nextId = 1;

export function listTasks() {
  return tasks;
}

export function addTask(title) {
  const task = { id: nextId++, title, done: false };
  tasks.push(task);
  return task;
}

export function findTask(id) {
  return tasks.find((t) => t.id === id) ?? null;
}
