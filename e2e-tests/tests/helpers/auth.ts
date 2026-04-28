import { expect, type Page } from "@playwright/test";

// Defaults align with the seeded MERT-M admin user. Override via env
// (E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD) for non-default environments.
// The password below is the local-dev default — production CI runs MUST
// pass real credentials via env. See e2e-tests/.env.local for the
// active dev value (gitignored).
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? "admin@mertm.bg";
const ADMIN_PASSWORD =
  process.env.E2E_ADMIN_PASSWORD ?? "36PWyyfdpxIt08VXlGjle1zf";

export async function openLoginPage(page: Page) {
  await page.goto("/login");
  await expect(page).toHaveURL(/\/login(?:[?#].*)?$/);
  await expect(page.locator('input[type="email"]')).toBeVisible();
}

export async function submitLoginForm(
  page: Page,
  email: string,
  password: string,
) {
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.locator('button[type="submit"]').first().click();
}

export async function loginAsAdmin(page: Page) {
  await openLoginPage(page);
  await submitLoginForm(page, ADMIN_EMAIL, ADMIN_PASSWORD);
  await expect(page).toHaveURL(/\/(?:[?#].*)?$/, { timeout: 10_000 });
  await expect(page.locator("nav, [role='navigation']").first()).toBeVisible();
}

export async function logoutViaUi(page: Page) {
  const candidates = [
    page.locator('button[title="Изход"]').first(),
    page.getByRole("button", { name: /изход|logout|sign out/i }).first(),
    page
      .locator("button")
      .filter({ has: page.locator("svg.lucide-log-out") })
      .first(),
  ];

  let clicked = false;
  for (const candidate of candidates) {
    const isVisible = await candidate
      .isVisible({ timeout: 1_500 })
      .catch(() => false);
    if (!isVisible) continue;

    await candidate.click();
    clicked = true;
    break;
  }

  if (!clicked) {
    throw new Error("Logout button not found");
  }

  await expect(page).toHaveURL(/\/login(?:[?#].*)?$/, { timeout: 10_000 });
  await expect(page.locator('input[type="email"]')).toBeVisible();
}
