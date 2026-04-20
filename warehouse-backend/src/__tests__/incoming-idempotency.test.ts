import crypto from "node:crypto";
import Fastify from "fastify";
import multipart from "@fastify/multipart";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({
  query: vi.fn(),
  transaction: vi.fn(),
}));

import { query, transaction } from "../db.js";
import incomingRoutes from "../routes/incoming.js";

const mockQuery = vi.mocked(query);
const mockTransaction = vi.mocked(transaction);

function resultRows<T>(rows: T[]) {
  return { rows } as any;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    return `{${entries
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function requestHash(value: unknown) {
  return crypto.createHash("sha256").update(stableStringify(value)).digest("hex");
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
    warnings: [],
    completeness_status: "complete",
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
      role: "owner_mobile",
    };
    (request as any).jwtVerify = async () => (request as any).user;
  });

  await app.register(incomingRoutes, { prefix: "/incoming" });
  return app;
}

describe("incoming idempotency", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockTransaction.mockReset();
  });

  it("replays an existing incoming for the same Idempotency-Key and payload", async () => {
    const payload = basePayload();
    mockQuery.mockResolvedValueOnce(
      resultRows([
        {
          id: 700,
          invoice_number: null,
          status: "pending",
          idempotency_request_hash: requestHash(payload),
          items: [{ id: 1, incoming_goods_id: 700, quantity: 1, unit_price: 10 }],
        },
      ]),
    );

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/incoming",
        headers: {
          "idempotency-key": "incoming-create-700",
        },
        payload,
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers["idempotency-replayed"]).toBe("true");
      expect(res.json()).toMatchObject({ id: 700, status: "pending" });
      expect(mockTransaction).not.toHaveBeenCalled();
      expect(mockQuery).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it("rejects reused Idempotency-Key when payload differs", async () => {
    const originalPayload = basePayload();
    mockQuery.mockResolvedValueOnce(
      resultRows([
        {
          id: 701,
          invoice_number: null,
          status: "pending",
          idempotency_request_hash: requestHash(originalPayload),
          items: [],
        },
      ]),
    );

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/incoming",
        headers: {
          "idempotency-key": "incoming-create-701",
        },
        payload: {
          ...originalPayload,
          invoice_date: "2026-04-10",
        },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({
        error: "idempotency_key_conflict",
        existing_id: 701,
      });
      expect(mockTransaction).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("replays after a unique-key race without repeating supplier side effects", async () => {
    const payload = basePayload();
    const txQueries: string[] = [];

    mockQuery
      .mockResolvedValueOnce(resultRows([]))
      .mockResolvedValueOnce(
        resultRows([
          {
            id: 702,
            invoice_number: null,
            status: "pending",
            idempotency_request_hash: requestHash(payload),
            items: [{ id: 2, incoming_goods_id: 702, quantity: 1, unit_price: 10 }],
          },
        ]),
      );

    mockTransaction.mockImplementation(async (fn: any) => {
      const txClient = {
        query: vi.fn(async (sql: string) => {
          txQueries.push(String(sql));
          if (sql.includes("INSERT INTO incoming_goods")) {
            const error = Object.assign(new Error("duplicate idempotency key"), {
              code: "23505",
              constraint: "incoming_goods_idempotency_key_key",
            });
            throw error;
          }
          return resultRows([]);
        }),
      };

      return fn(txClient as any);
    });

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/incoming",
        headers: {
          "idempotency-key": "incoming-create-702",
        },
        payload,
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers["idempotency-replayed"]).toBe("true");
      expect(res.json()).toMatchObject({ id: 702, status: "pending" });
      expect(txQueries.some((sql) => sql.includes("INSERT INTO incoming_goods"))).toBe(true);
      expect(txQueries.some((sql) => sql.includes("INSERT INTO suppliers"))).toBe(false);
    } finally {
      await app.close();
    }
  });
});
