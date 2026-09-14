// A fictional todo application, standing in for whatever product a project's
// tests actually drive. It exists so an audit fixture has a "right answer" to
// read that lives outside the project ccqa is run in.

export interface Todo {
  id: string;
  title: string;
}

export const NEW_ITEM_PLACEHOLDER = "What needs to be done?";

export function renderTodoList(items: readonly Todo[]): string {
  const rows = items
    .map(
      (item) =>
        `<li data-testid="todo-item">${item.title}<button>Delete</button></li>`,
    )
    .join("");
  return [
    `<section data-testid="todo-list">`,
    `<input placeholder="${NEW_ITEM_PLACEHOLDER}" />`,
    `<button>Add</button>`,
    `<ul>${rows}</ul>`,
    `</section>`,
  ].join("");
}

export function addItem(items: readonly Todo[], title: string): Todo[] {
  if (title.trim() === "") return [...items];
  return [{ id: `todo-${items.length + 1}`, title }, ...items];
}
