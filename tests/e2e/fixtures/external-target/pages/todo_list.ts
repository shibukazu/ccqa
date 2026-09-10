// Fixture page object for the external-target generation test. Playwright is
// not installed in this fixture, so a minimal structural Page type stands in.
interface LocatorLike {
  fill(value: string): Promise<void>;
}
interface PageLike {
  goto(url: string): Promise<unknown>;
  getByPlaceholder(text: string): LocatorLike;
}

/** Page object for the todo list screen. */
export class TodoListPage {
  constructor(private readonly page: PageLike) {}

  async open(baseUrl: string): Promise<void> {
    await this.page.goto(baseUrl);
  }

  async addItem(title: string): Promise<void> {
    await this.page.getByPlaceholder("What needs to be done?").fill(title);
  }
}
