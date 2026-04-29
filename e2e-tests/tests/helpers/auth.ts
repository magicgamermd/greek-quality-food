import { expect, type Page, type APIRequestContext } from "@playwright/test";

// Defaults align with the seeded MERT-M admin user. Override via env
// (E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD) for non-default environments.
// The password below is the local-dev default — production CI runs MUST
// pass real credentials via env. See e2e-tests/.env.local for the
// active dev value (gitignored).
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? "admin@mertm.bg";
const ADMIN_PASSWORD =
  process.env.E2E_ADMIN_PASSWORD ?? "36PWyyfdpxIt08VXlGjle1zf";

const BACKEND_BASE_URL =
  process.env.E2E_BACKEND_BASE_URL ?? "http://127.0.0.1:3004";

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

export async function ensureSalesUser(
  request: APIRequestContext,
  email: string,
  password: string,
): Promise<string> {
  // Login as admin to get a token
  const loginRes = await request.post(`${BACKEND_BASE_URL}/auth/login`, {
    data: {
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
    },
  });
  const adminToken = (await loginRes.json()).token;

  // Try to create the sales user; ignore 409 conflict (already exists)
  await request.post(`${BACKEND_BASE_URL}/users`, {
    headers: { Authorization: `Bearer ${adminToken}` },
    data: { name: "Sales Test", email, password, role: "sales" },
  });

  // Login as the sales user, return the token
  const salesRes = await request.post(`${BACKEND_BASE_URL}/auth/login`, {
    data: { email, password },
  });
  return (await salesRes.json()).token;
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
