import Fastify from "fastify";
import multipart from "@fastify/multipart";
import { beforeEach, describe, expect, it, vi } from "vitest";
import incomingRoutes from "../routes/incoming.js";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

vi.mock("../db.js", () => ({
  query: vi.fn(),
  transaction: vi.fn(),
}));

import { query, transaction } from "../db.js";

const mockQuery = vi.mocked(query);
const mockTransaction = vi.mocked(transaction);

function resultRows<T>(rows: T[]) {
  return { rows } as any;
}

function multipartUpload(filename = "invoice.txt", content = "invoice") {
  const boundary = "----vitest-boundary";
  const payload = [
    `--${boundary}`,
    `Content-Disposition: form-data; name="file"; filename="${filename}"`,
    "Content-Type: text/plain",
    "",
    content,
    `--${boundary}--`,
    "",
  ].join("\r\n");

  return {
    payload,
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`,
    },
  };
}

function basePayload() {
  return {
    supplier_name: "Test Supplier",
    invoice_number: null,
    invoice_date: "2026-04-09",
    document_type: "invoice",
    strict_review_mode: true,
    allow_auto_create_unmatched: false,
    visible_row_count: 1,
    extracted_row_count: 1,
    warnings: ["row_sequence_not_contiguous"],
    items: [
      {
        row_number: 1,
        page_number: 1,
        product_name_raw: "Raw Product",
        product_name: "Raw Product",
        name_bg: "Суров продукт",
        quantity: 1,
        unit_price: 10,
        unit: "кг",
      },
    ],
  };
}

async function buildApp() {
  const app = Fastify();
  await app.register(multipart);

  app.addHook("onRequest", async (request) => {
    (request as any).user = {
      id: "u-owner",
      email: "owner@test.local",
      role: "admin",
    };
    (request as any).jwtVerify = async () => (request as any).user;
  });

  await app.register(incomingRoutes, { prefix: "/incoming" });
  return app;
}

describe("incoming strict completeness gate", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockQuery.mockResolvedValue(resultRows([]));
    mockTransaction.mockReset();
    fetchMock.mockReset();
  });

  it("rejects incomplete extraction in strict review mode", async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/incoming",
        payload: {
          ...basePayload(),
          completeness_status: "incomplete",
          visible_row_count: 2,
          extracted_row_count: 1,
          warnings: ["row_count_mismatch: visible=2, extracted=1"],
        },
      });

      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({
        error: "incomplete_extraction",
        completeness_status: "incomplete",
        visible_row_count: 2,
        extracted_row_count: 1,
      });
      expect(mockQuery).not.toHaveBeenCalled();
      expect(mockTransaction).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("rejects suspicious extraction until review is explicitly accepted", async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/incoming",
        payload: {
          ...basePayload(),
          completeness_status: "suspicious",
        },
      });

      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({
        error: "suspicious_extraction_requires_review",
        completeness_status: "suspicious",
        visible_row_count: 1,
        extracted_row_count: 1,
      });
      expect(mockQuery).not.toHaveBeenCalled();
      expect(mockTransaction).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("allows suspicious extraction past gate when review was accepted", async () => {
    mockQuery.mockResolvedValueOnce(
      resultRows([
        {
          id: 101,
          invoice_number: "INV-101",
          status: "pending",
          created_at: new Date("2026-04-09T00:00:00.000Z").toISOString(),
        },
      ]),
    );

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/incoming",
        payload: {
          ...basePayload(),
          invoice_number: "INV-101",
          completeness_status: "suspicious",
          review_accepted_for_completeness: true,
        },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({
        error: "duplicate_invoice",
      });
      expect(mockQuery).toHaveBeenCalledTimes(1);
      expect(mockTransaction).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("persists alias in strict mode when product_id is explicitly provided", async () => {
    const txQueries: Array<{ sql: string; params?: any[] }> = [];
    const txClient = {
      query: vi.fn(async (sql: string, params?: any[]) => {
        txQueries.push({ sql: String(sql), params });

        if (sql.includes("SELECT id FROM suppliers WHERE name ILIKE")) {
          return resultRows([{ id: 55 }]);
        }
        if (sql.includes("INSERT INTO incoming_goods")) {
          return resultRows([
            {
              id: 501,
              supplier_id: 55,
              invoice_number: null,
              invoice_date: "2026-04-09",
              document_type: "invoice",
              scanned_file_path: null,
              status: "pending",
            },
          ]);
        }
        if (sql.includes("SELECT id FROM products WHERE id = $1")) {
          return resultRows([{ id: 321 }]);
        }
        if (sql.includes("INSERT INTO incoming_items")) {
          return resultRows([
            {
              id: 9001,
              incoming_goods_id: 501,
              product_id: 321,
              quantity: 1,
              unit_price: 10,
              total_price: 10,
            },
          ]);
        }
        if (sql.includes("SELECT id FROM product_aliases")) {
          return resultRows([]);
        }
        if (sql.includes("INSERT INTO product_aliases")) {
          return resultRows([]);
        }
        return resultRows([]);
      }),
    };
    mockTransaction.mockImplementation(async (fn: any) => fn(txClient as any));

    const app = await buildApp();
    try {
      const sourcePayload = basePayload();
      const res = await app.inject({
        method: "POST",
        url: "/incoming",
        payload: {
          ...sourcePayload,
          warnings: [],
          completeness_status: "complete",
          items: [
            {
              ...sourcePayload.items[0],
              product_id: 321,
            },
          ],
        },
      });

      expect(res.statusCode).toBe(201);
      const aliasInsert = txQueries.find(({ sql }) =>
        sql.includes("INSERT INTO product_aliases"),
      );
      expect(aliasInsert).toBeDefined();
      expect(aliasInsert?.params).toEqual(expect.arrayContaining([321, 55]));
    } finally {
      await app.close();
    }
  });

  it("keeps unresolved strict-mode rows blocked with 422 when auto-create is false", async () => {
    const txQueries: Array<string> = [];
    const txClient = {
      query: vi.fn(async (sql: string) => {
        txQueries.push(String(sql));

        if (sql.includes("SELECT id FROM suppliers WHERE name ILIKE")) {
          return resultRows([{ id: 77 }]);
        }
        if (sql.includes("INSERT INTO incoming_goods")) {
          return resultRows([
            {
              id: 601,
              supplier_id: 77,
              invoice_number: null,
              invoice_date: "2026-04-09",
              document_type: "invoice",
              scanned_file_path: null,
              status: "pending",
            },
          ]);
        }
        return resultRows([]);
      }),
    };
    mockTransaction.mockImplementation(async (fn: any) => fn(txClient as any));

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/incoming",
        payload: {
          ...basePayload(),
          warnings: [],
          completeness_status: "complete",
        },
      });

      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({
        message: expect.stringContaining("Unresolved product at row 1"),
      });
      expect(
        txQueries.some((sql) => sql.includes("INSERT INTO products")),
      ).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("stages selling_price for explicitly linked existing products without updating catalog price during pending save", async () => {
    mockQuery.mockResolvedValueOnce(resultRows([]));

    const txQueries: Array<{ sql: string; params?: any[] }> = [];
    const txClient = {
      query: vi.fn(async (sql: string, params?: any[]) => {
        txQueries.push({ sql: String(sql), params });

        if (sql.includes("SELECT id FROM suppliers WHERE name ILIKE")) {
          return resultRows([{ id: 88 }]);
        }
        if (sql.includes("INSERT INTO incoming_goods")) {
          return resultRows([
            {
              id: 777,
              supplier_id: 88,
              invoice_number: "INV-SP-1",
              invoice_date: "2026-04-09",
              document_type: "invoice",
              scanned_file_path: null,
              status: "pending",
            },
          ]);
        }
        if (sql.includes("SELECT id FROM products WHERE id = $1")) {
          return resultRows([{ id: 321 }]);
        }
        if (sql.includes("INSERT INTO incoming_items")) {
          return resultRows([
            {
              id: 9002,
              incoming_goods_id: 777,
              product_id: 321,
              quantity: 1,
              unit_price: 10,
              total_price: 10,
              selling_price: 19.99,
            },
          ]);
        }
        if (sql.includes("SELECT id FROM product_aliases")) {
          return resultRows([]);
        }
        if (sql.includes("INSERT INTO product_aliases")) {
          return resultRows([]);
        }
        return resultRows([]);
      }),
    };
    mockTransaction.mockImplementation(async (fn: any) => fn(txClient as any));

    const app = await buildApp();
    try {
      const sourcePayload = basePayload();
      const res = await app.inject({
        method: "POST",
        url: "/incoming",
        payload: {
          ...sourcePayload,
          invoice_number: "INV-SP-1",
          warnings: [],
          completeness_status: "complete",
          items: [
            {
              ...sourcePayload.items[0],
              product_id: 321,
              selling_price: 19.99,
            },
          ],
        },
      });

      expect(res.statusCode).toBe(201);
      const incomingItemInsert = txQueries.find(({ sql }) =>
        sql.includes("INSERT INTO incoming_items"),
      );
      // MERT-M: no batch_id on the INSERT — six params, not seven.
      expect(incomingItemInsert?.params).toEqual([777, 321, 1, 10, 10, 19.99]);

      const sellingPriceUpdate = txQueries.find(({ sql }) =>
        sql.includes("UPDATE products SET selling_price = $1"),
      );
      expect(sellingPriceUpdate).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("scan route surfaces eleven rows when AI returns sparse row-numbered extraction", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        supplier_name: "Greek Supplier",
        visible_row_count: 11,
        extracted_row_count: 11,
        completeness_status: "complete",
        line_items: {
          1: {
            row_number: 1,
            product_name_raw: "Item 1",
            quantity: 1,
            unit: "kg",
            unit_price: 1,
          },
          2: {
            row_number: 2,
            product_name_raw: "Item 2",
            quantity: 1,
            unit: "kg",
            unit_price: 1,
          },
          4: {
            row_number: 4,
            product_name_raw: "Item 4",
            quantity: 1,
            unit: "kg",
            unit_price: 1,
          },
          5: {
            row_number: 5,
            product_name_raw: "Item 5",
            quantity: 1,
            unit: "kg",
            unit_price: 1,
          },
          7: {
            row_number: 7,
            product_name_raw: "Item 7",
            quantity: 1,
            unit: "kg",
            unit_price: 1,
          },
          11: {
            row_number: 11,
            product_name_raw: "Item 11",
            quantity: 1,
            unit: "kg",
            unit_price: 1,
          },
        },
      }),
    } as any);

    const app = await buildApp();
    try {
      const upload = multipartUpload();
      const res = await app.inject({
        method: "POST",
        url: "/incoming/scan",
        payload: upload.payload,
        headers: upload.headers,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.visible_row_count).toBe(11);
      expect(body.extracted_row_count).toBe(11);
      expect(body.items).toHaveLength(11);
      expect(body.items.map((item: any) => item.row_number)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
      ]);
      expect(body.items[2].product_name_raw).toBe("UNKNOWN_ROW_3");
      expect(body.items[9].product_name_raw).toBe("UNKNOWN_ROW_10");
    } finally {
      await app.close();
    }
  });

  it("scan route surfaces five rows when AI returns sparse row-numbered extraction", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        supplier_name: "Greek Supplier",
        visible_row_count: 5,
        extracted_row_count: 5,
        completeness_status: "complete",
        line_items: {
          1: {
            row_number: 1,
            product_name_raw: "Item 1",
            quantity: 1,
            unit: "kg",
            unit_price: 1,
          },
          3: {
            row_number: 3,
            product_name_raw: "Item 3",
            quantity: 1,
            unit: "kg",
            unit_price: 1,
          },
          5: {
            row_number: 5,
            product_name_raw: "Item 5",
            quantity: 1,
            unit: "kg",
            unit_price: 1,
          },
        },
      }),
    } as any);

    const app = await buildApp();
    try {
      const upload = multipartUpload();
      const res = await app.inject({
        method: "POST",
        url: "/incoming/scan",
        payload: upload.payload,
        headers: upload.headers,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.visible_row_count).toBe(5);
      expect(body.extracted_row_count).toBe(5);
      expect(body.items).toHaveLength(5);
      expect(body.items.map((item: any) => item.row_number)).toEqual([
        1, 2, 3, 4, 5,
      ]);
      expect(body.items[1].product_name_raw).toBe("UNKNOWN_ROW_2");
      expect(body.items[3].product_name_raw).toBe("UNKNOWN_ROW_4");
    } finally {
      await app.close();
    }
  });

  it("scan route returns duplicate invoice metadata without a second client roundtrip", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        supplier_name: "Greek Supplier",
        invoice_number: "INV-55",
        visible_row_count: 1,
        extracted_row_count: 1,
        completeness_status: "complete",
        line_items: [
          {
            row_number: 1,
            product_name_raw: "Item 1",
            quantity: 1,
            unit: "kg",
            unit_price: 1,
          },
        ],
      }),
    } as any);
    // The scan route now resolves supplier_id (alias → EIK) before the
    // duplicate check so tier-2 fuzzy dedupe has a scope. Route the
    // mock by SQL content: alias + EIK + EIK conflict lookups return
    // empty; only the findDuplicateInvoice tier-1 query returns the hit.
    mockQuery.mockImplementation(async (sql: string) => {
      if (
        sql.includes("FROM incoming_goods") &&
        sql.includes("REGEXP_REPLACE(COALESCE(invoice_number") &&
        !sql.includes("levenshtein")
      ) {
        return resultRows([
          { id: 42, status: "pending", created_at: "2026-04-16T10:00:00.000Z" },
        ]);
      }
      return resultRows([]);
    });

    const app = await buildApp();
    try {
      const upload = multipartUpload();
      const res = await app.inject({
        method: "POST",
        url: "/incoming/scan",
        payload: upload.payload,
        headers: upload.headers,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        invoice_number: "INV-55",
        duplicate_invoice: {
          duplicate: true,
          existing_id: 42,
          status: "pending",
        },
      });
    } finally {
      await app.close();
    }
  });

  it("match-preview pads missing AI matches instead of misaligning rows", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        matches: [
          {
            matched_product_id: 10,
            matched_product_name: "Feta",
            match_source: "alias",
          },
          {
            matched_product_id: 30,
            matched_product_name: "Olives",
            match_source: "sku",
          },
        ],
      }),
    } as any);

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/incoming/match-preview",
        payload: {
          supplier_name: "Greek Supplier",
          items: [
            { product_name_raw: "Row 1", quantity: 1, unit_price: 1 },
            { product_name_raw: "Row 2", quantity: 1, unit_price: 1 },
            { product_name_raw: "Row 3", quantity: 1, unit_price: 1 },
          ],
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        matches: [
          {
            matched_product_id: 10,
            matched_product_name: "Feta",
            match_source: "alias",
          },
          {
            matched_product_id: 30,
            matched_product_name: "Olives",
            match_source: "sku",
          },
          { match_source: "none", suggestions: [] },
        ],
      });
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/ai/match-products"),
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining('"preview_mode":true'),
        }),
      );
    } finally {
      await app.close();
    }
  });
});
