import { initAuth } from "./auth.js";
import { initFilter } from "./filter.js";
import { initTasks, reloadTasks, renderTasks } from "./tasks.js";

initAuth(() => {
  void reloadTasks();
});
initTasks();
initFilter(() => {
  renderTasks();
});
