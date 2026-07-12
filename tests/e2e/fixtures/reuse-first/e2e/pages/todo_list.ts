// Fixture page object for the reuse-first generation test. Playwright is not
// installed in this fixture, so a minimal structural Page type stands in.
interface PageLike {
  goto(url: string): Promise<unknown>;
  fill(selector: string, value: string): Promise<void>;
  press(selector: string, key: string): Promise<void>;
}

/** Test id shared by every rendered todo row. */
export const TODO_ITEM_TESTID = "todo-item";

/** Page object for the todo list screen. */
export class TodoListPage {
  constructor(private readonly page: PageLike) {}

  async open(baseUrl: string): Promise<void> {
    await this.page.goto(baseUrl);
  }

  async addItem(title: string): Promise<void> {
    await this.page.fill("[placeholder='What needs to be done?']", title);
    await this.page.press("[placeholder='What needs to be done?']", "Enter");
  }
}
