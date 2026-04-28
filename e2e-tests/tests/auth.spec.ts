import { test, expect } from "@playwright/test";
import {
  loginAsAdmin,
  logoutViaUi,
  openLoginPage,
  submitLoginForm,
} from "./helpers/auth";

test.describe("Authentication", () => {
  test("Login with valid credentials → expect dashboard", async ({ page }) => {
    await loginAsAdmin(page);
    await expect(page).not.toHaveURL(/\/login(?:[?#].*)?$/);
  });

  test("Login with wrong password → expect error and stay on login", async ({
    page,
  }) => {
    await openLoginPage(page);
    await submitLoginForm(page, "admin@mertm.bg", "WrongPassword123");

    await expect(page).toHaveURL(/\/login(?:[?#].*)?$/);
    await expect(
      page.getByText(
        /Грешен имейл или парола|Invalid email or password|Грешка при вход/i,
      ),
    ).toBeVisible();
  });

  test("Logout → expect redirect to login", async ({ page }) => {
    await loginAsAdmin(page);
    await logoutViaUi(page);
  });
});
