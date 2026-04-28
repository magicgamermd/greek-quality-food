import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { loginAsAdmin } from "./helpers/auth";

const BACKEND_BASE_URL =
  process.env.E2E_BACKEND_BASE_URL ?? "http://127.0.0.1:3004";

type AuthHeaders = Record<string, string>;

type InventoryRow = {
  product_id: number;
  total_stock: number | string;
};

type InventoryResponse = {
  data: InventoryRow[];
  pagination?: {
    total?: number;
  };
};

type DuplicateInvoiceResponse = {
  duplicate: boolean;
  existing_id?: number;
  status?: string;
};

type IncomingItemDetails = {
  product_id: number;
  quantity: number | string;
};

type IncomingDetailsResponse = {
  id: number;
  invoice_number: string;
  status: string;
  items: IncomingItemDetails[];
};

function toNumber(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return parsed;
}

async function getAuthHeaders(page: Page): Promise<AuthHeaders> {
  const token = await page.evaluate(() => window.localStorage.getItem("token"));
  if (token) {
    return { Authorization: `Bearer ${token}` };
  }

  const cookies = await page.context().cookies(BACKEND_BASE_URL);
  const tokenCookie = cookies.find((cookie) => cookie.name === "token")?.value;
  if (tokenCookie) {
    return { Cookie: `token=${tokenCookie}` };
  }

  throw new Error("No auth token found after login.");
}

async function getJson<T>(
  request: APIRequestContext,
  url: string,
  headers: AuthHeaders,
): Promise<T> {
  const response = await request.get(url, { headers });
  if (!response.ok()) {
    throw new Error(
      `GET ${url} failed with HTTP ${response.status()}: ${await response.text()}`,
    );
  }
  return (await response.json()) as T;
}

async function checkInvoice(
  request: APIRequestContext,
  headers: AuthHeaders,
  invoiceNumber: string,
): Promise<DuplicateInvoiceResponse> {
  return getJson<DuplicateInvoiceResponse>(
    request,
    `${BACKEND_BASE_URL}/incoming/check-duplicate?invoice_number=${encodeURIComponent(invoiceNumber)}`,
    headers,
  );
}

async function getIncomingDetails(
  request: APIRequestContext,
  headers: AuthHeaders,
  deliveryId: number,
): Promise<IncomingDetailsResponse> {
  return getJson<IncomingDetailsResponse>(
    request,
    `${BACKEND_BASE_URL}/incoming/${deliveryId}`,
    headers,
  );
}

async function fetchInventoryStockByProduct(
  request: APIRequestContext,
  headers: AuthHeaders,
): Promise<Map<number, number>> {
  const limit = 100;
  const stockByProductId = new Map<number, number>();
  let pageNum = 1;

  while (true) {
    const payload = await getJson<InventoryResponse>(
      request,
      `${BACKEND_BASE_URL}/inventory?limit=${limit}&page=${pageNum}`,
      headers,
    );
    const rows = payload.data ?? [];

    for (const row of rows) {
      stockByProductId.set(row.product_id, toNumber(row.total_stock));
    }

    const total = payload.pagination?.total ?? 0;
    if (rows.length === 0 || pageNum * limit >= total) {
      break;
    }
    pageNum += 1;
  }

  return stockByProductId;
}

test.describe("Full Warehouse Flow", () => {
  test("Complete E2E flow: Login → Create Delivery → Verify in Inventory", async ({
    page,
  }) => {
    const timestamp = Date.now();
    const invoiceNumber = `E2E-FLOW-${timestamp}`;
    const testSupplier = "Тест Е2Е";

    console.log("Step 1: Logging in...");
    await loginAsAdmin(page);
    await expect(page).not.toHaveURL(/\/login(?:[?#].*)?$/);

    const authHeaders = await getAuthHeaders(page);
    const inventoryBefore = await fetchInventoryStockByProduct(
      page.request,
      authHeaders,
    );

    console.log(
      "Step 2: Navigating to Incoming Goods and opening manual entry...",
    );
    await page.goto("/incoming");
    await expect(page).toHaveURL(/\/incoming(?:[?#].*)?$/);
    await page.waitForSelector("table, [role='grid']", { timeout: 10000 });

    const newDeliveryBtn = page.getByRole("button", { name: /нова доставка/i });
    await expect(newDeliveryBtn).toBeVisible({ timeout: 10000 });
    await newDeliveryBtn.click();

    const manualEntryBtn = page.getByRole("button", {
      name: /ръчно въвеждане/i,
    });
    await expect(manualEntryBtn).toBeVisible({ timeout: 5000 });
    await manualEntryBtn.click();

    const manualDialog = page
      .getByRole("dialog")
      .filter({ hasText: /ръчно въвеждане на доставка/i });
    await expect(manualDialog).toBeVisible({ timeout: 10000 });

    console.log(
      `Step 3: Filling manual-entry form with supplier "${testSupplier}" and invoice "${invoiceNumber}"...`,
    );
    await manualDialog
      .getByPlaceholder("Име на нов доставчик")
      .fill(testSupplier);
    await manualDialog.getByPlaceholder("0000123456").fill(invoiceNumber);

    console.log("Step 4: Adding item in manual-entry form...");
    await manualDialog
      .getByPlaceholder("Търси продукт...")
      .first()
      .fill(`E2E продукт ${timestamp}`);
    await manualDialog.locator('input[type="number"]').first().fill("100");
    await manualDialog.locator('input[type="number"]').nth(1).fill("5.50");

    console.log("Step 5: Saving manual delivery...");
    await manualDialog
      .getByRole("button", { name: /запиши доставка/i })
      .click();
    await expect(manualDialog).toBeHidden({ timeout: 10000 });

    console.log(
      "Step 6: Verifying delivery and inventory impact via backend API...",
    );

    await expect
      .poll(
        async () => {
          const probe = await checkInvoice(
            page.request,
            authHeaders,
            invoiceNumber,
          );
          return probe.status ?? "missing";
        },
        {
          timeout: 20_000,
          message: `Delivery with invoice ${invoiceNumber} was not confirmed.`,
        },
      )
      .toBe("confirmed");

    const invoiceProbe = await checkInvoice(
      page.request,
      authHeaders,
      invoiceNumber,
    );
    expect(invoiceProbe.duplicate).toBe(true);
    expect(invoiceProbe.existing_id).toBeTruthy();
    if (!invoiceProbe.existing_id) {
      throw new Error(
        `Delivery with invoice ${invoiceNumber} was not created.`,
      );
    }

    const deliveryDetails = await getIncomingDetails(
      page.request,
      authHeaders,
      invoiceProbe.existing_id,
    );

    expect(deliveryDetails.status).toBe("confirmed");
    expect(deliveryDetails.invoice_number).toBe(invoiceNumber);
    expect(deliveryDetails.items.length).toBeGreaterThan(0);

    const deliveredByProduct = new Map<number, number>();
    for (const item of deliveryDetails.items) {
      const productId = Number(item.product_id);
      const quantity = toNumber(item.quantity);
      if (!Number.isFinite(productId) || quantity <= 0) continue;
      deliveredByProduct.set(
        productId,
        (deliveredByProduct.get(productId) ?? 0) + quantity,
      );
    }
    expect(deliveredByProduct.size).toBeGreaterThan(0);

    const inventoryAfter = await fetchInventoryStockByProduct(
      page.request,
      authHeaders,
    );

    for (const [productId, deliveredQty] of deliveredByProduct.entries()) {
      const before = inventoryBefore.get(productId) ?? 0;
      const after = inventoryAfter.get(productId);
      expect(
        after,
        `Missing inventory row for product ${productId} after confirming delivery ${invoiceProbe.existing_id}.`,
      ).not.toBeUndefined();
      if (after === undefined) continue;

      expect(
        after,
        `Inventory for product ${productId} did not increase by at least ${deliveredQty}. Before=${before}, after=${after}.`,
      ).toBeGreaterThanOrEqual(before + deliveredQty - 0.0001);
    }

    await page.goto("/inventory");
    await page.waitForSelector("table, [role='grid']", { timeout: 10000 });
    await expect(page).toHaveURL(/\/inventory(?:[?#].*)?$/);

    console.log("Full E2E flow completed with verified stock impact.");
  });

  test("Incoming goods page is accessible", async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto("/incoming");
    await page.waitForSelector("table, [role='grid']", { timeout: 10000 });
    await expect(page).toHaveURL(/\/incoming(?:[?#].*)?$/);
  });

  test("Inventory page is accessible", async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto("/inventory");
    await page.waitForSelector("table, [role='grid']", { timeout: 10000 });
    await expect(page).toHaveURL(/\/inventory(?:[?#].*)?$/);
  });
});
