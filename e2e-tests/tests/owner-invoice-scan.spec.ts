import path from "path";
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { loginAsAdmin } from "./helpers/auth";

const BACKEND_BASE_URL = process.env.E2E_BACKEND_BASE_URL ?? "http://127.0.0.1:3003";
const INVOICE_FILE = path.resolve(__dirname, "../../test-invoices/No5.pdf");
const PRODUCT_SEARCH_TERM = "ФЕТА";

type AuthHeaders = Record<string, string>;

type ScanItem = {
  row_number?: number | null;
  page_number?: number | null;
  name?: string | null;
  name_en?: string | null;
  name_bg?: string | null;
  product_name?: string | null;
  product_name_raw?: string | null;
  product_code?: string | null;
  product_code_raw?: string | null;
  quantity?: number | null;
  unit_price?: number | null;
  price?: number | null;
};

type ScanResponse = {
  supplier_name?: string | null;
  supplier_eik?: string | null;
  invoice_date?: string | null;
  invoice_number?: string | null;
  currency?: string | null;
  visible_row_count?: number | null;
  extracted_row_count?: number | null;
  completeness_status?: "complete" | "suspicious" | "incomplete" | null;
  warnings?: string[];
  needs_review?: boolean;
  scanned_file_path?: string | null;
  items: ScanItem[];
};

const OWNER_SCAN_FIXTURE: ScanResponse = {
  supplier_name: "Demo Supplier",
  supplier_eik: "123456789",
  invoice_date: "2026-04-14",
  invoice_number: "DEMO-NO5",
  currency: "BGN",
  visible_row_count: 3,
  extracted_row_count: 3,
  completeness_status: "suspicious",
  warnings: ["E2E fixture scan used for owner manual matching flow."],
  needs_review: true,
  scanned_file_path: "/tmp/e2e-owner-invoice-scan-No5.pdf",
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
    {
      row_number: 2,
      page_number: 1,
      name_bg: "МАСЛИНИ КАЛАМАТА 1КГ",
      name_en: "KALAMATA OLIVES 1KG",
      product_name: "МАСЛИНИ КАЛАМАТА 1КГ",
      product_name_raw: "МАСЛИНИ КАЛАМАТА 1КГ",
      quantity: 1,
      unit_price: 12.2,
      price: 12.2,
    },
    {
      row_number: 3,
      page_number: 1,
      name_bg: "ЗЕХТИН EXTRA VIRGIN 500МЛ",
      name_en: "EXTRA VIRGIN OLIVE OIL 500ML",
      product_name: "ЗЕХТИН EXTRA VIRGIN 500МЛ",
      product_name_raw: "ЗЕХТИН EXTRA VIRGIN 500МЛ",
      quantity: 1,
      unit_price: 14.9,
      price: 14.9,
    },
  ],
};

const OWNER_MATCH_FIXTURE: MatchResult[] = OWNER_SCAN_FIXTURE.items.map(() => ({
  match_source: "none",
  confidence: 0,
  suggestions: [],
}));

type MatchResult = {
  matched_product_id?: number | null;
  matched_product_name?: string | null;
  matched_product_sku?: string | null;
  confidence?: number | null;
  match_source?: string | null;
  suggestions?: unknown[];
};

type AliasRecord = {
  id: number;
  alias_name: string;
  product_id: number;
  supplier_id?: number | null;
};

type Product = {
  id: number;
  name_bg?: string | null;
  name_en?: string | null;
  sku?: string | null;
  selling_price?: string | number | null;
  purchase_price?: string | number | null;
  unit?: string | null;
  low_stock_threshold?: string | number | null;
  brand?: string | null;
  category_id?: number | null;
};

function isAutoMatched(match: MatchResult | undefined): boolean {
  if (!match?.matched_product_id) return false;
  if (match.match_source === "alias" || match.match_source === "sku") return true;
  return (match.confidence ?? 0) >= 0.75;
}

async function loginViaApi(request: APIRequestContext): Promise<AuthHeaders> {
  const response = await request.post(`${BACKEND_BASE_URL}/auth/login`, {
    data: {
      email: "admin@greekfoods.bg",
      password: "GreekFoods2026!",
    },
  });
  expect(response.ok()).toBeTruthy();
  const payload = await response.json();
  return { Authorization: `Bearer ${payload.token}` };
}

async function getAuthHeaders(page: Page): Promise<AuthHeaders> {
  const token = await page.evaluate(() => window.localStorage.getItem("token"));
  if (token) return { Authorization: `Bearer ${token}` };
  throw new Error("No auth token found in localStorage after login.");
}

async function scanInvoice(
  request: APIRequestContext,
  headers: AuthHeaders,
): Promise<ScanResponse> {
  const response = await request.post(`${BACKEND_BASE_URL}/incoming/scan`, {
    headers,
    multipart: {
      file: {
        name: path.basename(INVOICE_FILE),
        mimeType: "application/pdf",
        buffer: require("fs").readFileSync(INVOICE_FILE),
      },
    },
    timeout: 180_000,
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as ScanResponse;
}

async function matchPreview(
  request: APIRequestContext,
  headers: AuthHeaders,
  scanned: ScanResponse,
): Promise<MatchResult[]> {
  const response = await request.post(`${BACKEND_BASE_URL}/incoming/match-preview`, {
    headers: {
      ...headers,
      "Content-Type": "application/json",
    },
    data: {
      supplier_name: scanned.supplier_name ?? null,
      supplier_eik: scanned.supplier_eik ?? null,
      items: scanned.items.map((item) => ({
        name: item.name ?? null,
        name_en: item.name_en ?? null,
        name_bg: item.name_bg ?? null,
        product_name: item.product_name ?? null,
        product_name_raw: item.product_name_raw ?? null,
        product_code: item.product_code ?? null,
        product_code_raw: item.product_code_raw ?? null,
        quantity: item.quantity ?? null,
        unit_price: item.unit_price ?? item.price ?? null,
        price: item.price ?? null,
      })),
    },
    timeout: 180_000,
  });
  expect(response.ok()).toBeTruthy();
  const payload = await response.json();
  return Array.isArray(payload.matches) ? payload.matches : [];
}

async function fetchAliases(
  request: APIRequestContext,
  headers: AuthHeaders,
  search: string,
): Promise<AliasRecord[]> {
  const response = await request.get(
    `${BACKEND_BASE_URL}/product-aliases?search=${encodeURIComponent(search)}`,
    { headers },
  );
  expect(response.ok()).toBeTruthy();
  const payload = await response.json();
  return Array.isArray(payload?.data) ? (payload.data as AliasRecord[]) : [];
}

async function deleteAlias(
  request: APIRequestContext,
  headers: AuthHeaders,
  aliasId: number,
): Promise<void> {
  const response = await request.delete(`${BACKEND_BASE_URL}/product-aliases/${aliasId}`, {
    headers,
  });
  expect(response.ok()).toBeTruthy();
}

async function lookupAlias(
  request: APIRequestContext,
  headers: AuthHeaders,
  aliasName: string,
): Promise<AliasRecord | null> {
  const response = await request.get(
    `${BACKEND_BASE_URL}/product-aliases/lookup?alias_name=${encodeURIComponent(aliasName)}`,
    { headers },
  );
  expect(response.ok()).toBeTruthy();
  const payload = await response.json();
  return (payload?.match as AliasRecord | null) ?? null;
}

async function findProductBySearch(
  request: APIRequestContext,
  headers: AuthHeaders,
  search: string,
): Promise<Product> {
  const response = await request.get(
    `${BACKEND_BASE_URL}/products?search=${encodeURIComponent(search)}&limit=10`,
    { headers },
  );
  expect(response.ok()).toBeTruthy();
  const payload = await response.json();
  const products = Array.isArray(payload) ? payload : payload?.data ?? [];
  expect(products.length).toBeGreaterThan(0);
  return products[0] as Product;
}

function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function getProduct(
  request: APIRequestContext,
  headers: AuthHeaders,
  productId: number,
): Promise<Product> {
  const response = await request.get(`${BACKEND_BASE_URL}/products/${productId}`, {
    headers,
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as Product;
}

async function updateProduct(
  request: APIRequestContext,
  headers: AuthHeaders,
  productId: number,
  product: Product,
): Promise<void> {
  const response = await request.put(`${BACKEND_BASE_URL}/products/${productId}`, {
    headers: {
      ...headers,
      "Content-Type": "application/json",
    },
    data: {
      name_bg: product.name_bg ?? undefined,
      name_en: product.name_en ?? undefined,
      sku: product.sku ?? undefined,
      category_id: product.category_id ?? null,
      unit: product.unit ?? undefined,
      low_stock_threshold: toNullableNumber(product.low_stock_threshold),
      brand: product.brand ?? null,
      purchase_price: toNullableNumber(product.purchase_price),
      selling_price: toNullableNumber(product.selling_price),
    },
  });
  expect(response.ok()).toBeTruthy();
}

async function findIncomingByInvoiceNumber(
  request: APIRequestContext,
  headers: AuthHeaders,
  invoiceNumber: string,
) {
  const response = await request.get(
    `${BACKEND_BASE_URL}/incoming?date_from=2026-01-01&date_to=2026-12-31`,
    { headers },
  );
  expect(response.ok()).toBeTruthy();
  const payload = await response.json();
  const rows = Array.isArray(payload) ? payload : payload?.data ?? [];
  const match = rows.find((row: any) => row?.invoice_number === invoiceNumber);
  expect(match).toBeTruthy();
  return match as { id: number; status: string; invoice_number: string };
}

async function getIncomingDetails(
  request: APIRequestContext,
  headers: AuthHeaders,
  incomingId: number,
) {
  const response = await request.get(`${BACKEND_BASE_URL}/incoming/${incomingId}`, {
    headers,
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as { items?: Array<any>; status?: string };
}

async function mockOwnerInvoiceScanApis(page: Page): Promise<void> {
  await page.route("**/incoming/scan", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(OWNER_SCAN_FIXTURE),
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
      body: JSON.stringify({ matches: OWNER_MATCH_FIXTURE }),
    });
  });
}

test.describe("Owner invoice scan manual matching", () => {
  test.setTimeout(180_000);

  test("manual bind saves pending incoming and remembers alias for next preview", async ({
    page,
    request,
  }) => {
    const apiHeaders = await loginViaApi(request);
    const scanned = OWNER_SCAN_FIXTURE;
    const matchesBefore = OWNER_MATCH_FIXTURE;

    const targetIndex = scanned.items.findIndex((item, index) => {
      const ocr = item.product_name_raw ?? item.name_bg ?? item.name_en ?? item.name ?? "";
      return ocr.includes(PRODUCT_SEARCH_TERM) && !isAutoMatched(matchesBefore[index]);
    });
    expect(targetIndex).toBeGreaterThanOrEqual(0);

    const product = await findProductBySearch(request, apiHeaders, PRODUCT_SEARCH_TERM);
    const originalProduct = await getProduct(request, apiHeaders, product.id);
    const aliasesBefore = await fetchAliases(request, apiHeaders, PRODUCT_SEARCH_TERM);
    for (const alias of aliasesBefore.filter(
      (entry) => entry.product_id === product.id && entry.alias_name.includes(PRODUCT_SEARCH_TERM),
    )) {
      await deleteAlias(request, apiHeaders, alias.id);
    }

    const updatedSellingPrice = 23.45;

    try {
      await mockOwnerInvoiceScanApis(page);
      await loginAsAdmin(page);
      await page.goto("/owner/incoming/scan");
      await expect(page).toHaveURL(/\/owner\/incoming\/scan(?:[?#].*)?$/);

      await page.locator('input[type="file"]').setInputFiles(INVOICE_FILE);
      await expect(page.getByText(/Редове от фактурата/i)).toBeVisible({ timeout: 60_000 });

      const targetRow = page
        .locator("div.rounded-lg")
        .filter({ hasText: /Нужна връзка/ })
        .filter({ hasText: PRODUCT_SEARCH_TERM })
        .first();

      await expect(targetRow).toBeVisible({ timeout: 30_000 });

      const rowTitle = (await targetRow.locator("p").first().textContent()) ?? "";
      const targetAlias = rowTitle.replace(/^Ред\s+\d+:\s*/i, "").trim();
      expect(targetAlias.length).toBeGreaterThan(0);

      const searchInput = targetRow.getByPlaceholder(/Търси продукт по име\/SKU/i);
      await searchInput.fill(PRODUCT_SEARCH_TERM);
      await targetRow.getByRole("button", { name: /^Търси$/ }).click();

      const productOption = targetRow.getByRole("button", {
        name: new RegExp(product.name_bg ?? product.name_en ?? PRODUCT_SEARCH_TERM, "i"),
      });
      await expect(productOption).toBeVisible({ timeout: 15_000 });
      await productOption.click();

      await targetRow.getByRole("button", { name: /Свържи избрания продукт/i }).click();

      const linkedTargetRow = page.locator("div.rounded-lg").filter({ hasText: targetAlias }).first();
      await expect(linkedTargetRow.getByText(new RegExp(product.name_bg ?? product.name_en ?? PRODUCT_SEARCH_TERM, "i"))).toBeVisible({ timeout: 15_000 });

      await linkedTargetRow.getByPlaceholder(/0\.00/i).fill(updatedSellingPrice.toFixed(2));

      for (let i = 0; i < 5; i += 1) {
        const unresolvedCreateButtons = page
          .locator("div.rounded-lg")
          .filter({ hasText: /Нужна връзка/ })
          .getByRole("button", { name: /Създай нов/i });
        const count = await unresolvedCreateButtons.count();
        if (count === 0) break;
        await unresolvedCreateButtons.first().click();
        await page.waitForTimeout(1000);
      }

      const invoiceNumber = `E2E-OWNER-SCAN-${Date.now()}`;
      await page.locator('input:not([type="file"])').nth(1).fill(invoiceNumber);
      await page.getByRole("checkbox").check();

      await page.getByRole("button", { name: /Запази като чакаща доставка/i }).click();
      await expect(page.getByText(/Фактурата е записана успешно/i)).toBeVisible({ timeout: 20_000 });

      const aliasesAfter = await fetchAliases(request, apiHeaders, targetAlias);
      const savedAlias = aliasesAfter.find((entry) => entry.alias_name === targetAlias);
      expect(savedAlias).toBeTruthy();
      expect(savedAlias?.product_id).toBe(product.id);

      const lookedUpAlias = await lookupAlias(request, apiHeaders, targetAlias);
      expect(lookedUpAlias).toBeTruthy();
      expect(lookedUpAlias?.product_id).toBe(product.id);

      const savedIncoming = await findIncomingByInvoiceNumber(
        request,
        apiHeaders,
        invoiceNumber,
      );
      expect(savedIncoming.status).toBe("pending");

      const savedIncomingDetails = await getIncomingDetails(
        request,
        apiHeaders,
        savedIncoming.id,
      );
      const savedLine = (savedIncomingDetails.items ?? []).find(
        (entry: any) => Number(entry?.product_id) === product.id,
      );
      expect(savedLine).toBeTruthy();
      expect(toNullableNumber(savedLine?.selling_price)).toBe(updatedSellingPrice);

      const updatedProduct = await getProduct(request, apiHeaders, product.id);
      expect(toNullableNumber(updatedProduct.selling_price)).toBe(
        toNullableNumber(originalProduct.selling_price),
      );
    } finally {
      await updateProduct(request, apiHeaders, product.id, originalProduct);
    }
  });
});
