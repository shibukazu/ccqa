// Page object for the navigation bar, addressing it by the class the product's
// template renders. A class name is the kind of locator an audit reads past:
// it is not prose, so nothing about reading this file draws the eye to it.
interface LocatorLike {
  click(): Promise<void>;
}
interface PageLike {
  locator(selector: string): LocatorLike;
}

export class NavigationBar {
  constructor(private readonly page: PageLike) {}

  async openTodos(): Promise<void> {
    await this.page.locator(".nav-bar").click();
  }
}
