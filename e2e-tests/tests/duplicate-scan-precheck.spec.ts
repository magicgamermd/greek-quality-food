import path from "path";
import { expect, test, type Page } from "@playwright/test";
import { loginAsAdmin } from "./helpers/auth";

const INVOICE_FILE = path.resolve(__dirname, "../../test-invoices/No5.pdf");
const DUPLICATE_INVOICE_NUMBER = "DUP-INV-2026-001";
const DUPLICATE_MESSAGE =
  "⚠️ Дублирана фактура\n\n" +
  `Фактура ${DUPLICATE_INVOICE_NUMBER} вече е вкарана.\n` +
  "Дата: 14.04.2026 г.\n" +
  "Статус: ✅ Потвърдена\n\n" +
  "Искате ли да сканирате отново?";
const CANCELLED_MESSAGE =
  `Сканирането е прекратено: фактура ${DUPLICATE_INVOICE_NUMBER} вече съществува.`;

const SCAN_FIXTURE = {
  supplier_name: "Demo Supplier",
  supplier_eik: "123456789",
  invoice_date: "2026-04-14",
  invoice_number: DUPLICATE_INVOICE_NUMBER,
  currency: "BGN",
  items: [
    {
      row_number: 1,
      page_number: 1,
      name_bg: "СИРЕНЕ ФЕТА 400Г",
      name_en: "FETA CHEESE 400G",
      product_name: "СИРЕНЕ ФЕТА 400Г",
      product_name_raw: "СИРЕНЕ ФЕТА 400Г",
      quantity: 2,
      unit_price: 8.5,
      price: 8.5,
    },
  ],
};

async function mockDuplicatePrecheck(page: Page) {
  await page.route("**/incoming/quick-invoice-check", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ invoice_number: DUPLICATE_INVOICE_NUMBER }),
    });
  });

  await page.route("**/incoming/check-duplicate**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        duplicate: true,
        existing_id: 42,
        status: "confirmed",
        created_at: "2026-04-14T09:00:00.000Z",
      }),
    });
  });

  await page.route("**/incoming/scan", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(SCAN_FIXTURE),
    });
  });

  await page.route("**/incoming/match-preview", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        matches: SCAN_FIXTURE.items.map(() => ({
          match_source: "none",
          confidence: 0,
          suggestions: [],
        })),
      }),
    });
  });
}

type SurfaceCase = {
  name: string;
  path: string;
  successText: RegExp;
};

const SURFACES: SurfaceCase[] = [
  {
    name: "owner",
    path: "/owner/incoming/scan",
    successText: /Данни от сканиране/i,
  },
  {
    name: "warehouse",
    path: "/incoming?scan=1",
    successText: /AI успешно извлече данните от документа/i,
  },
];

for (const surface of SURFACES) {
  test(`${surface.name}: duplicate precheck can be dismissed and keeps scan blocked`, async ({
    page,
  }) => {
    await mockDuplicatePrecheck(page);
    await loginAsAdmin(page);
    await page.goto(surface.path);

    const dialogPromise = page.waitForEvent("dialog");
    await page.locator('input[type="file"]').first().setInputFiles(INVOICE_FILE);
    const dialog = await dialogPromise;

    expect(dialog.message()).toBe(DUPLICATE_MESSAGE);
    await dialog.dismiss();

    await expect(page.getByText(CANCELLED_MESSAGE)).toBeVisible({ timeout: 15_000 });
  });

  test(`${surface.name}: duplicate precheck can be accepted and scan continues`, async ({
    page,
  }) => {
    await mockDuplicatePrecheck(page);
    await loginAsAdmin(page);
    await page.goto(surface.path);

    const dialogPromise = page.waitForEvent("dialog");
    await page.locator('input[type="file"]').first().setInputFiles(INVOICE_FILE);
    const dialog = await dialogPromise;

    expect(dialog.message()).toBe(DUPLICATE_MESSAGE);
    await dialog.accept();

    await expect(page.getByText(surface.successText)).toBeVisible({ timeout: 30_000 });
  });
}
