/**
 * E2E tests: permission system scenarios
 *
 * Covers:
 *  1. Sales role — gated columns absent on /products
 *  2. Sales role — sidebar items hidden/visible by permission
 *  3. Admin grants an override permission for a sales user
 *  4. Admin cannot grant overrides to another admin (lockout banner)
 */

import { test, expect } from "@playwright/test";
import {
  loginAsAdmin,
  openLoginPage,
  submitLoginForm,
  ensureSalesUser,
} from "./helpers/auth";

const SALES_EMAIL = "sales-e2e@mertm.bg";
const SALES_PASSWORD = "SalesE2eTest!2026";

// ---------------------------------------------------------------------------
// Test 1: Sales user does not see "Доставна цена" / "Марж" on /products,
//         but DOES see "Цена на едро" (always-visible column).
// ---------------------------------------------------------------------------
test("sales role: /products hides purchase price columns", async ({
  page,
  request,
}) => {
  await ensureSalesUser(request, SALES_EMAIL, SALES_PASSWORD);

  await openLoginPage(page);
  await submitLoginForm(page, SALES_EMAIL, SALES_PASSWORD);
  await expect(page).toHaveURL(/\/(?:[?#].*)?$/, { timeout: 10_000 });

  await page.goto("/products");
  await expect(page.locator("table, [role='table']").first()).toBeVisible({
    timeout: 10_000,
  });

  // Columns that must NOT be visible for the sales role
  await expect(
    page.getByRole("columnheader", { name: "Доставна цена" }),
  ).not.toBeVisible();
  await expect(
    page.getByRole("columnheader", { name: "Марж" }),
  ).not.toBeVisible();

  // Column that IS always visible
  await expect(
    page.getByRole("columnheader", { name: "Цена на едро" }),
  ).toBeVisible();
});

// ---------------------------------------------------------------------------
// Test 2: Sales user sidebar — hidden: Анализи, Настройки, Приемане на стоки
//                               visible: Поръчки, Фактури
// ---------------------------------------------------------------------------
test("sales role: sidebar shows correct nav items", async ({
  page,
  request,
}) => {
  await ensureSalesUser(request, SALES_EMAIL, SALES_PASSWORD);

  await openLoginPage(page);
  await submitLoginForm(page, SALES_EMAIL, SALES_PASSWORD);
  await expect(page).toHaveURL(/\/(?:[?#].*)?$/, { timeout: 10_000 });

  const nav = page.locator("nav, [role='navigation']").first();
  await expect(nav).toBeVisible({ timeout: 8_000 });

  // Gated items — sales role lacks REPORTS_VIEW / SETTINGS_MANAGE / INCOMING_MANAGE
  await expect(nav.getByText("Анализи")).not.toBeVisible();
  await expect(nav.getByText("Настройки")).not.toBeVisible();
  await expect(nav.getByText("Приемане на стоки")).not.toBeVisible();

  // Items the sales role CAN see
  await expect(nav.getByText("Поръчки")).toBeVisible();
  await expect(nav.getByText("Фактури")).toBeVisible();
});

// ---------------------------------------------------------------------------
// Test 3: Admin grants an override permission to the sales user
//         → sees "✏️ override" badge on that permission row.
// ---------------------------------------------------------------------------
test("admin can grant override permission to sales user", async ({
  page,
  request,
}) => {
  // Ensure the sales user exists; capture numeric id from the user list
  await ensureSalesUser(request, SALES_EMAIL, SALES_PASSWORD);

  await loginAsAdmin(page);

  // Navigate to the settings / users page
  await page.goto("/settings");
  await expect(page).toHaveURL(/\/settings(?:[?#/].*)?$/, { timeout: 10_000 });

  // Find the sales test user row and open their detail page
  const userRow = page
    .locator("tr, [data-testid='user-row']")
    .filter({ hasText: SALES_EMAIL })
    .first();
  await expect(userRow).toBeVisible({ timeout: 10_000 });

  // Click through to user detail — either the row itself or a link/button inside it
  const detailLink = userRow
    .locator("a, button")
    .filter({ hasText: /детайли|редактирай|управлявай|Sales Test/i })
    .first();
  const hasDetailLink = await detailLink
    .isVisible({ timeout: 1_500 })
    .catch(() => false);

  if (hasDetailLink) {
    await detailLink.click();
  } else {
    await userRow.click();
  }

  // Wait for the permission matrix to appear
  await expect(page).toHaveURL(/\/settings\/users\/\d+/, { timeout: 10_000 });

  // Find the "invoices.cancel" checkbox and toggle it on
  const invoicesCancelCheckbox = page
    .locator(
      "input[type='checkbox'][data-permission='invoices.cancel'], " +
        "input[type='checkbox'][name='invoices.cancel']",
    )
    .first();

  // Fallback: look for a checkbox next to a label that says "invoices.cancel"
  const checkboxVisible = await invoicesCancelCheckbox
    .isVisible({ timeout: 2_000 })
    .catch(() => false);

  if (checkboxVisible) {
    await invoicesCancelCheckbox.check();
  } else {
    // Look for the text and find its sibling checkbox
    const label = page
      .locator("label, td, div")
      .filter({ hasText: /invoices\.cancel|Анулиране на фактури/i })
      .first();
    await expect(label).toBeVisible({ timeout: 5_000 });
    await label.locator("input[type='checkbox']").check();
  }

  // Fill in the mandatory reason field
  const reasonField = page
    .locator(
      "textarea[name='reason'], input[name='reason'], [data-testid='override-reason']",
    )
    .first();
  const hasReason = await reasonField
    .isVisible({ timeout: 1_500 })
    .catch(() => false);
  if (hasReason) {
    await reasonField.fill("E2E тест — временен достъп");
  }

  // Submit / confirm the override
  const confirmBtn = page
    .getByRole("button", { name: /запази|потвърди|приложи|save|confirm/i })
    .first();
  await confirmBtn.click();

  // The override badge should appear in the UI
  await expect(
    page
      .locator("text=✏️ override")
      .or(page.locator("[data-badge='override']")),
  ).toBeVisible({ timeout: 8_000 });
});

// ---------------------------------------------------------------------------
// Test 4: Admin detail page for another admin shows lockout banner.
// ---------------------------------------------------------------------------
test("admin detail page for another admin shows all-permissions banner", async ({
  page,
}) => {
  await loginAsAdmin(page);

  // Navigate to settings / users
  await page.goto("/settings");
  await expect(page).toHaveURL(/\/settings(?:[?#/].*)?$/, { timeout: 10_000 });

  // Find any admin user row (other than the current one) — or use admin@mertm.bg itself
  const adminRow = page
    .locator("tr, [data-testid='user-row']")
    .filter({ hasText: /admin/i })
    .first();
  await expect(adminRow).toBeVisible({ timeout: 10_000 });

  const detailLink = adminRow
    .locator("a, button")
    .filter({ hasText: /детайли|редактирай|управлявай|admin/i })
    .first();
  const hasLink = await detailLink
    .isVisible({ timeout: 1_500 })
    .catch(() => false);

  if (hasLink) {
    await detailLink.click();
  } else {
    await adminRow.click();
  }

  await expect(page).toHaveURL(/\/settings\/users\/\d+/, { timeout: 10_000 });

  // The lockout banner must be present
  await expect(
    page
      .getByText(/Admin има всички разрешения/i)
      .or(page.getByText(/администраторът има всички права/i))
      .or(page.locator("[data-testid='admin-lockout-banner']")),
  ).toBeVisible({ timeout: 8_000 });
});
