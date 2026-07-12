// Fixture step helper for the reuse-first generation test (structural Page
// type — Playwright is not installed in this fixture).
interface PageLike {
  fill(selector: string, value: string): Promise<void>;
  click(selector: string): Promise<void>;
}

/** Signs the test account in via the login form. */
export async function login(page: PageLike, email: string, password: string): Promise<void> {
  await page.fill("[aria-label='Email']", email);
  await page.fill("[aria-label='Password']", password);
  await page.click("text=Sign in");
}
