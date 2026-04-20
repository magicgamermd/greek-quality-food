import path from "path";
import { expect, test, type Page } from "@playwright/test";
import { loginAsAdmin } from "./helpers/auth";

const INVOICE_FILE = path.resolve(__dirname, "../../test-invoices/No5.pdf");
const SEARCH_TERM = "ФЕТА";

const SCAN_FIXTURE = {
  supplier_name: "Demo Supplier",
  supplier_eik: "123456789",
  invoice_date: "2026-04-14",
  invoice_number: "DEMO-WH-01",
  currency: "EUR",
  scanned_file_path: "/tmp/e2e-incoming-goods-scan-No5.pdf",
  items: [
    {
      row_number: 1,
      page_number: 1,
      name_bg: "СИРЕНЕ ФЕТА 400Г",
      name_en: "FETA CHEESE 400G",
      product_name: "СИРЕНЕ ФЕТА 400Г",
      product_name_raw: "СИРЕНЕ ФЕТА 400Г",
      quantity: 2,
      unit: "бр",
      unit_price: 8.5,
      price: 8.5,
    },
    {
      row_number: 2,
      page_number: 1,
      name_bg: "МАСЛИНИ КАЛАМАТА 1КГ",
      name_en: "KALAMATA OLIVES 1KG",
      product_name: "МАСЛИНИ КАЛАМАТА 1КГ",
      product_name_raw: "МАСЛИНИ КАЛАМАТА 1КГ",
      quantity: 1,
      unit: "бр",
      unit_price: 12.2,
      price: 12.2,
    },
  ],
};

const MATCH_FIXTURE = [
  {
    match_source: "none",
    confidence: 0,
    suggestions: [],
  },
  {
    matched_product_id: 902,
    matched_product_name: "МАСЛИНИ КАЛАМАТА 1КГ",
    matched_product_sku: "SKU-902",
    matched_purchase_price: 12.2,
    matched_selling_price: 18.9,
    match_source: "alias",
    confidence: 1,
    suggestions: [],
  },
];

const SEARCH_RESULTS = [
  {
    id: 501,
    name_bg: "СИРЕНЕ ФЕТА 400Г",
    name_en: "FETA CHEESE 400G",
    sku: "SKU-501",
    unit: "бр",
    purchase_price: 8.5,
    selling_price: 15.4,
  },
  {
    id: 777,
    name_bg: "МАСЛИНОВА ТАПЕНАДА 190Г",
    name_en: "OLIVE TAPENADE 190G",
    sku: "SKU-777",
    unit: "бр",
    purchase_price: 9.3,
    selling_price: 16.7,
  },
];

async function mockIncomingScanApis(
  page: Page,
  options?: {
    onIncomingPost?: (payload: any) => void | Promise<void>;
    confirmStatus?: number;
    confirmBody?: Record<string, unknown>;
    batchPatchStatus?: number;
    batchPatchBody?: Record<string, unknown>;
  },
): Promise<void> {
  await page.route("**/incoming?date_from=**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([]),
    });
  });

  await page.route("**/suppliers", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([{ id: 1, name: "Demo Supplier" }]),
    });
  });

  await page.route("**/incoming/quick-invoice-check", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ invoice_number: SCAN_FIXTURE.invoice_number }),
    });
  });

  await page.route("**/incoming/check-duplicate**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ duplicate: false }),
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
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ matches: MATCH_FIXTURE }),
    });
  });

  await page.route("**/products?search=**", async (route) => {
    const search = new URL(route.request().url()).searchParams
      .get("search")
      ?.toLowerCase();
    const results = search?.includes("тап") ? SEARCH_RESULTS.slice(1) : SEARCH_RESULTS;

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(results),
    });
  });

  await page.route("**/incoming", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }

    const payload = route.request().postDataJSON();
    await options?.onIncomingPost?.(payload);

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: 101,
        items: [
          { id: 201, product_id: 501, quantity: 2, unit_price: 8.5 },
          { id: 202, product_id: 902, quantity: 1, unit_price: 12.2 },
        ],
      }),
    });
  });

  await page.route("**/incoming/101/confirm", async (route) => {
    await route.fulfill({
      status: options?.confirmStatus ?? 200,
      contentType: "application/json",
      body: JSON.stringify(options?.confirmBody ?? { success: true }),
    });
  });

  await page.route("**/incoming/101/batches", async (route) => {
    await route.fulfill({
      status: options?.batchPatchStatus ?? 200,
      contentType: "application/json",
      body: JSON.stringify(options?.batchPatchBody ?? { success: true }),
    });
  });
}

test.describe("Incoming goods scan review UX", () => {
  test("matches owner-style row review with inline bind and selling price", async ({ page }) => {
    let submittedPayload: any = null;
    await mockIncomingScanApis(page, {
      onIncomingPost: async (payload) => {
        submittedPayload = payload;
      },
    });
    await loginAsAdmin(page);
    await page.goto("/incoming");
    await expect(page).toHaveURL(/\/incoming(?:[?#].*)?$/);

    await page.getByRole("button", { name: /Нова доставка/i }).click();
    await page.getByRole("button", { name: /Сканиране на документ/i }).click();
    await page.locator('input[type="file"]').setInputFiles(INVOICE_FILE);

    await expect(page.getByText(/Артикули \(2\)/i)).toBeVisible({ timeout: 30_000 });

    const fetaRow = page
      .locator("div.rounded-lg")
      .filter({ hasText: /СИРЕНЕ ФЕТА 400Г/i })
      .filter({ hasText: /Нужна връзка/i })
      .first();

    await expect(fetaRow).toBeVisible();
    await expect(fetaRow.getByText(/Продукт в склада/i)).toBeVisible();
    await expect(fetaRow.getByText(/Продажна цена/i)).toBeVisible();

    const sellingPriceInput = fetaRow.locator('input[type="number"]').nth(1);
    await expect(sellingPriceInput).toBeVisible();
    await sellingPriceInput.fill("19.99");

    const searchInput = fetaRow.getByPlaceholder(/Търси продукт по име\/SKU/i);
    await expect(searchInput).toBeVisible();
    await searchInput.fill(SEARCH_TERM);
    await fetaRow.getByRole("button", { name: /^Търси$/ }).click();

    const option = fetaRow.getByRole("button", { name: /СИРЕНЕ ФЕТА 400Г/i }).first();
    await expect(option).toBeVisible();
    await option.click();
    await fetaRow.getByRole("button", { name: /Свържи избрания продукт/i }).click();

    const linkedFetaRow = page
      .locator("div.rounded-lg")
      .filter({ hasText: /СИРЕНЕ ФЕТА 400Г/i })
      .first();

    await expect(linkedFetaRow.getByText(/Свързан продукт/i)).toBeVisible();
    await expect(linkedFetaRow.getByText(/SKU SKU-501/i)).toBeVisible();
    await expect(linkedFetaRow.getByRole("button", { name: /Смени продукта/i })).toBeVisible();

    await page.getByRole("button", { name: /Запази доставката/i }).click();
    await expect(page.getByText(/Дати на годност и партиди/i)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/Задай продажни цени/i)).toHaveCount(0);

    expect(submittedPayload?.items?.[0]?.product_id).toBe(501);
    expect(submittedPayload?.items?.[0]?.selling_price).toBe(19.99);
    expect(submittedPayload?.items?.[1]?.product_id).toBe(902);
    expect(submittedPayload?.items?.[1]?.selling_price).toBeUndefined();
  });

  test("allows overriding an auto-matched row before save", async ({ page }) => {
    let submittedPayload: any = null;
    await mockIncomingScanApis(page, {
      onIncomingPost: async (payload) => {
        submittedPayload = payload;
      },
    });

    await loginAsAdmin(page);
    await page.goto("/incoming");
    await expect(page).toHaveURL(/\/incoming(?:[?#].*)?$/);

    await page.getByRole("button", { name: /Нова доставка/i }).click();
    await page.getByRole("button", { name: /Сканиране на документ/i }).click();
    await page.locator('input[type="file"]').setInputFiles(INVOICE_FILE);

    await expect(page.getByText(/Артикули \(2\)/i)).toBeVisible({ timeout: 30_000 });

    const fetaRow = page
      .locator("div.rounded-lg")
      .filter({ hasText: /СИРЕНЕ ФЕТА 400Г/i })
      .first();
    await fetaRow.getByPlaceholder(/Търси продукт по име\/SKU/i).fill(SEARCH_TERM);
    await fetaRow.getByRole("button", { name: /^Търси$/ }).click();
    await fetaRow.getByRole("button", { name: /СИРЕНЕ ФЕТА 400Г/i }).first().click();
    await fetaRow.getByRole("button", { name: /Свържи избрания продукт/i }).click();

    const olivesRow = page
      .locator("div.rounded-lg")
      .filter({ hasText: /МАСЛИНИ КАЛАМАТА 1КГ/i })
      .first();

    await expect(olivesRow.getByText(/Свързан продукт/i)).toBeVisible();
    await olivesRow.getByRole("button", { name: /Смени продукта/i }).click();

    const remapSearchInput = olivesRow.getByPlaceholder(/Търси продукт по име\/SKU/i);
    await expect(remapSearchInput).toBeVisible();
    await remapSearchInput.fill("ТАПЕНАДА");
    await olivesRow.getByRole("button", { name: /^Търси$/ }).click();

    const replacementOption = olivesRow
      .getByRole("button", { name: /МАСЛИНОВА ТАПЕНАДА 190Г/i })
      .first();
    await expect(replacementOption).toBeVisible();
    await replacementOption.click();
    await olivesRow.getByRole("button", { name: /Смени с избрания продукт/i }).click();

    await expect(olivesRow.getByText(/SKU SKU-777/i)).toBeVisible();

    await page.getByRole("button", { name: /Запази доставката/i }).click();
    await expect(page.getByText(/Дати на годност и партиди/i)).toBeVisible({ timeout: 15_000 });

    expect(submittedPayload?.items?.[0]?.product_id).toBe(501);
    expect(submittedPayload?.items?.[1]?.product_id).toBe(777);
  });

  test("shows a visible confirmation failure after save when auto-confirm fails", async ({ page }) => {
    await mockIncomingScanApis(page, {
      confirmStatus: 500,
      confirmBody: { message: "Потвърждението не успя" },
    });

    await loginAsAdmin(page);
    await page.goto("/incoming");
    await expect(page).toHaveURL(/\/incoming(?:[?#].*)?$/);

    await page.getByRole("button", { name: /Нова доставка/i }).click();
    await page.getByRole("button", { name: /Сканиране на документ/i }).click();
    await page.locator('input[type="file"]').setInputFiles(INVOICE_FILE);

    await expect(page.getByText(/Артикули \(2\)/i)).toBeVisible({ timeout: 30_000 });

    const fetaRow = page
      .locator("div.rounded-lg")
      .filter({ hasText: /СИРЕНЕ ФЕТА 400Г/i })
      .first();
    await fetaRow.getByPlaceholder(/Търси продукт по име\/SKU/i).fill(SEARCH_TERM);
    await fetaRow.getByRole("button", { name: /^Търси$/ }).click();
    await fetaRow.getByRole("button", { name: /СИРЕНЕ ФЕТА 400Г/i }).first().click();
    await fetaRow.getByRole("button", { name: /Свържи избрания продукт/i }).click();

    await page.getByRole("button", { name: /Запази доставката/i }).click();

    await expect(page.getByText(/Потвърждението не успя/i)).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByRole("heading", { name: /Дати на годност и партиди/i })).toBeVisible();
  });

  test("keeps the batch modal open and shows patch failure when batch save fails", async ({ page }) => {
    await mockIncomingScanApis(page, {
      batchPatchStatus: 500,
      batchPatchBody: {
        message: "Партидите и сроковете не бяха записани",
      },
    });

    await loginAsAdmin(page);
    await page.goto("/incoming");
    await expect(page).toHaveURL(/\/incoming(?:[?#].*)?$/);

    await page.getByRole("button", { name: /Нова доставка/i }).click();
    await page.getByRole("button", { name: /Сканиране на документ/i }).click();
    await page.locator('input[type="file"]').setInputFiles(INVOICE_FILE);

    await expect(page.getByText(/Артикули \(2\)/i)).toBeVisible({ timeout: 30_000 });

    const fetaRow = page
      .locator("div.rounded-lg")
      .filter({ hasText: /СИРЕНЕ ФЕТА 400Г/i })
      .first();
    await fetaRow.getByPlaceholder(/Търси продукт по име\/SKU/i).fill(SEARCH_TERM);
    await fetaRow.getByRole("button", { name: /^Търси$/ }).click();
    await fetaRow.getByRole("button", { name: /СИРЕНЕ ФЕТА 400Г/i }).first().click();
    await fetaRow.getByRole("button", { name: /Свържи избрания продукт/i }).click();

    await page.getByRole("button", { name: /Запази доставката/i }).click();
    await page.getByRole("button", { name: /Ще въведа ръчно/i }).click();

    const batchInputs = page.getByPlaceholder(/напр\. 00245680/i);
    await batchInputs.first().fill("LOT-FAIL-01");
    await page.getByRole("button", { name: /Запази датите/i }).click();

    await expect(page.getByText(/Партидите и сроковете не бяха записани/i)).toBeVisible();
    await expect(page.getByRole("heading", { name: /Въведи дати на годност/i })).toBeVisible();
    await expect(batchInputs.first()).toHaveValue("LOT-FAIL-01");
  });
});
