import { apiAddTask, apiListTasks, apiToggleTask } from "./api.js";
import { currentFilter } from "./filter.js";

// Task list: add via the form (submit covers both the "Add task" button and
// pressing Enter in the field), toggle done via each row's checkbox.

let tasks = [];

export function initTasks() {
  const form = document.getElementById("add-form");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = document.getElementById("new-task");
    const title = input.value.trim();
    if (!title) return;
    tasks.push(await apiAddTask(title));
    input.value = "";
    renderTasks();
  });
}

export async function reloadTasks() {
  tasks = await apiListTasks();
  renderTasks();
}

export function renderTasks() {
  const list = document.getElementById("task-list");
  list.replaceChildren();
  for (const task of visibleTasks()) {
    list.appendChild(renderRow(task));
  }
  renderCount();
}

function visibleTasks() {
  const filter = currentFilter();
  if (filter === "active") return tasks.filter((t) => !t.done);
  if (filter === "completed") return tasks.filter((t) => t.done);
  return tasks;
}

function renderRow(task) {
  const item = document.createElement("li");
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = task.done;
  checkbox.setAttribute("aria-label", `Complete ${task.title}`);
  checkbox.addEventListener("change", async () => {
    const updated = await apiToggleTask(task.id, checkbox.checked);
    task.done = updated.done;
    renderTasks();
  });
  const title = document.createElement("span");
  title.textContent = task.title;
  if (task.done) title.classList.add("done");
  item.append(checkbox, title);
  return item;
}

function renderCount() {
  const remaining = tasks.filter((t) => !t.done).length;
  const noun = remaining === 1 ? "task" : "tasks";
  document.getElementById("task-count").textContent = `${remaining} ${noun} left`;
}
