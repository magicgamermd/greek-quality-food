/**
 * OCR-tolerant invoice duplicate detection — integration regression.
 *
 * Scenario that motivated migration 040 (fuzzystrmatch + tier-2 fuzzy):
 *   1. Driver hands over a PDF invoice A-JNE-ENA00014 from DAGKOS.
 *   2. Back-office scans the PDF → saved as invoice_number "A-JNE-ENA00014".
 *   3. Owner later snaps a phone photo of the SAME sheet from a different
 *      angle; Claude reads it as "A.INE-EN0A000014" (J→I, extra 0, . vs -).
 *
 * Tier-1 exact-string dedupe missed the match, so the system created a
 * duplicate row. Tier-2 applies the OCR-collapse key
 * (`invoiceOcrKey` → `AINEENAOOOI4` vs `AINEENOAOOOOI4`) and uses
 * `fuzzystrmatch.levenshtein(...) <= 2` scoped to the same supplier_id
 * within the last 180 days.
 *
 * These tests assert that:
 *   - Exact duplicate (tier-1) returns HTTP 409 with duplicate_invoice payload.
 *   - OCR-shifted duplicate (tier-2) also returns HTTP 409 when supplier_id matches.
 *   - Cross-supplier near-match does NOT duplicate-block (different companies
 *     can legitimately have similar invoice numbers).
 *   - Non-duplicate passes through to normal save flow.
 */
import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import incomingRoutes from "../routes/incoming.js";

vi.mock("../db.js", () => ({
  query: vi.fn(),
  transaction: vi.fn(),
}));

import { query, transaction } from "../db.js";

const mockQuery = vi.mocked(query);
const mockTransaction = vi.mocked(transaction);
const resultRows = <T>(rows: T[]) => ({ rows }) as any;

async function buildApp() {
  const app = Fastify();
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

type StoredInvoice = {
  id: number;
  supplier_id: number;
  invoice_number: string;
  status: string;
  created_at: string;
};

/**
 * Stub `findDuplicateInvoice` SQL handlers: tier-1 (exact) and tier-2 (fuzzy).
 * Returns the first matching stored invoice so the route responds 409.
 */
function buildDuplicateStub(storedInvoices: StoredInvoice[]) {
  const calls = { tier1: 0, tier2: 0 };

  const handler = async (sql: string, params: any[] = []) => {
    // Tier 1: exact-normalized match (no supplier_id filter, any supplier)
    if (
      sql.includes("FROM incoming_goods") &&
      sql.includes("REGEXP_REPLACE(COALESCE(invoice_number") &&
      !sql.includes("levenshtein")
    ) {
      calls.tier1 += 1;
      const normalized = params[0] as string;
      const digitsOnly = params[1] as string;
      const hit = storedInvoices.find(
        (inv) =>
          sqlNormalize(inv.invoice_number) === normalized ||
          (digitsOnly &&
            digitsOnly.length >= 6 &&
            inv.invoice_number.replace(/\D/g, "") === digitsOnly),
      );
      return resultRows(hit ? [hit] : []);
    }

    // Tier 2: levenshtein fuzzy, scoped to supplier
    if (sql.includes("levenshtein") && sql.includes("FROM incoming_goods")) {
      calls.tier2 += 1;
      const newKey = params[0] as string;
      const supplierId = params[1] as number;
      const hit = storedInvoices.find(
        (inv) =>
          inv.supplier_id === supplierId &&
          levenshtein(ocrKey(inv.invoice_number), newKey) <= 2,
      );
      return resultRows(
        hit
          ? [
              {
                ...hit,
                edit_distance: levenshtein(ocrKey(hit.invoice_number), newKey),
              },
            ]
          : [],
      );
    }

    return resultRows([]);
  };

  return { handler, calls };
}

/** SQL-side normalize equivalent: Greek→Latin + keep only A-Z0-9- uppercase. */
function sqlNormalize(value: string): string {
  const greek: Record<string, string> = {
    Α: "A",
    Β: "B",
    Γ: "G",
    Δ: "D",
    Ε: "E",
    Ζ: "Z",
    Η: "H",
    Θ: "TH",
    Ι: "I",
    Κ: "K",
    Λ: "L",
    Μ: "M",
    Ν: "N",
    Ξ: "X",
    Ο: "O",
    Π: "P",
    Ρ: "R",
    Σ: "S",
    Τ: "T",
    Υ: "Y",
    Φ: "F",
    Χ: "X",
    Ψ: "PS",
    Ω: "O",
  };
  return value
    .split("")
    .map((c) => greek[c] ?? c)
    .join("")
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, "");
}

/** OCR-collapse key — mirrors invoiceOcrKey() in production. */
function ocrKey(value: string): string {
  const collapsed: Record<string, string> = {
    J: "I",
    L: "I",
    "1": "I",
    Q: "O",
    "0": "O",
    "2": "Z",
    "5": "S",
    "8": "B",
    "6": "G",
  };
  return sqlNormalize(value)
    .replace(/-/g, "")
    .split("")
    .map((c) => collapsed[c] ?? c)
    .join("");
}

/** Minimal Levenshtein — matches PostgreSQL fuzzystrmatch.levenshtein(). */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const dp: number[] = Array(b.length + 1)
    .fill(0)
    .map((_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let prev = i - 1;
    dp[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const tmp = dp[j];
      dp[j] =
        a[i - 1] === b[j - 1] ? prev : Math.min(prev, dp[j], dp[j - 1]) + 1;
      prev = tmp;
    }
  }
  return dp[b.length];
}

describe("OCR-tolerant duplicate detection (tier-1 + tier-2)", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockTransaction.mockReset();
  });

  const DAGKOS_PDF: StoredInvoice = {
    id: 53,
    supplier_id: 16,
    invoice_number: "A-JNE-ENA00014",
    status: "confirmed",
    created_at: "2026-04-17T10:00:00Z",
  };

  it("tier-1: exact-string match returns 409", async () => {
    const stub = buildDuplicateStub([DAGKOS_PDF]);
    mockQuery.mockImplementation(stub.handler as any);

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/incoming",
        payload: {
          supplier_id: 16,
          supplier_name: "DAGKOS",
          invoice_number: "A-JNE-ENA00014", // same string
          invoice_date: "2026-04-17",
          document_type: "invoice",
          visible_row_count: 1,
          extracted_row_count: 1,
          warnings: [],
          completeness_status: "complete",
          items: [
            {
              row_number: 1,
              page_number: 1,
              product_name_raw: "x",
              product_name: "x",
              product_id: 321,
              quantity: 1,
              unit_price: 1,
              unit: "бр",
            },
          ],
        },
      });

      expect(res.statusCode).toBe(409);
      const body = res.json();
      expect(body.error).toBe("duplicate_invoice");
      expect(body.existing_id).toBe(53);
      expect(stub.calls.tier1).toBe(1);
      expect(stub.calls.tier2).toBe(0); // tier-1 short-circuited tier-2
    } finally {
      await app.close();
    }
  });

  it("tier-2: OCR-shifted phone photo match returns 409", async () => {
    const stub = buildDuplicateStub([DAGKOS_PDF]);
    mockQuery.mockImplementation(stub.handler as any);

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/incoming",
        payload: {
          supplier_id: 16, // same supplier — required for tier-2 scope
          supplier_name: "DAGKOS",
          invoice_number: "A.INE-EN0A000014", // phone OCR variant
          invoice_date: "2026-04-17",
          document_type: "invoice",
          visible_row_count: 1,
          extracted_row_count: 1,
          warnings: [],
          completeness_status: "complete",
          items: [
            {
              row_number: 1,
              page_number: 1,
              product_name_raw: "x",
              product_name: "x",
              product_id: 321,
              quantity: 1,
              unit_price: 1,
              unit: "бр",
            },
          ],
        },
      });

      expect(res.statusCode).toBe(409);
      const body = res.json();
      expect(body.error).toBe("duplicate_invoice");
      expect(body.existing_id).toBe(53);
      expect(stub.calls.tier1).toBe(1); // tier-1 missed
      expect(stub.calls.tier2).toBe(1); // tier-2 caught
    } finally {
      await app.close();
    }
  });

  it("cross-supplier near-match does NOT block (tier-2 is scoped)", async () => {
    // Same OCR key but different supplier — must pass, not dedupe.
    const stub = buildDuplicateStub([
      { ...DAGKOS_PDF, supplier_id: 16 }, // DAGKOS
    ]);
    mockQuery.mockImplementation(async (sql: string, params: any[] = []) => {
      // Add a products-table SELECT and minimal scaffolding so the save
      // flow can proceed past duplicate check when supplier differs.
      if (sql.includes("SELECT id FROM products WHERE id = $1")) {
        return resultRows([{ id: params[0] }]);
      }
      return stub.handler(sql, params);
    });
    mockTransaction.mockImplementation(async (fn: any) =>
      fn({
        query: vi.fn(async (sql: string, params: any[] = []) => {
          if (sql.includes("INSERT INTO incoming_goods"))
            return resultRows([
              {
                id: 999,
                supplier_id: params[0] ?? null,
                invoice_number: params[1] ?? null,
                status: "pending",
              },
            ]);
          if (sql.includes("UPDATE incoming_goods"))
            return resultRows([{ id: 999, supplier_id: 17 }]);
          if (sql.includes("INSERT INTO incoming_items"))
            return resultRows([{ id: 1001 }]);
          if (sql.includes("SELECT id FROM products WHERE id = $1"))
            return resultRows([{ id: params[0] }]);
          return resultRows([]);
        }),
      }),
    );

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/incoming",
        payload: {
          supplier_id: 17, // DIFFERENT supplier
          supplier_name: "Other Co.",
          invoice_number: "A.INE-EN0A000014", // same OCR-collapsed key
          invoice_date: "2026-04-17",
          document_type: "invoice",
          visible_row_count: 1,
          extracted_row_count: 1,
          warnings: [],
          completeness_status: "complete",
          items: [
            {
              row_number: 1,
              page_number: 1,
              product_name_raw: "x",
              product_name: "x",
              product_id: 321,
              quantity: 1,
              unit_price: 1,
              unit: "бр",
            },
          ],
        },
      });

      // Not 409 — passes duplicate gate
      expect(res.statusCode).not.toBe(409);
      // Tier-1 checked (global), tier-2 checked (scoped to supplier 17 — no hit)
      expect(stub.calls.tier1).toBe(1);
      expect(stub.calls.tier2).toBe(1);
    } finally {
      await app.close();
    }
  });

  it("unique invoice number passes through both tiers", async () => {
    const stub = buildDuplicateStub([DAGKOS_PDF]);
    mockQuery.mockImplementation(async (sql: string, params: any[] = []) => {
      if (sql.includes("SELECT id FROM products WHERE id = $1")) {
        return resultRows([{ id: params[0] }]);
      }
      return stub.handler(sql, params);
    });
    mockTransaction.mockImplementation(async (fn: any) =>
      fn({
        query: vi.fn(async (sql: string, params: any[] = []) => {
          if (sql.includes("INSERT INTO incoming_goods"))
            return resultRows([
              {
                id: 1000,
                supplier_id: params[0] ?? null,
                invoice_number: params[1] ?? null,
                status: "pending",
              },
            ]);
          if (sql.includes("UPDATE incoming_goods"))
            return resultRows([{ id: 1000, supplier_id: 16 }]);
          if (sql.includes("INSERT INTO incoming_items"))
            return resultRows([{ id: 2002 }]);
          if (sql.includes("SELECT id FROM products WHERE id = $1"))
            return resultRows([{ id: params[0] }]);
          return resultRows([]);
        }),
      }),
    );

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/incoming",
        payload: {
          supplier_id: 16,
          supplier_name: "DAGKOS",
          invoice_number: "A-JNE-ENA99999", // same supplier, different inv
          invoice_date: "2026-04-17",
          document_type: "invoice",
          visible_row_count: 1,
          extracted_row_count: 1,
          warnings: [],
          completeness_status: "complete",
          items: [
            {
              row_number: 1,
              page_number: 1,
              product_name_raw: "x",
              product_name: "x",
              product_id: 321,
              quantity: 1,
              unit_price: 1,
              unit: "бр",
            },
          ],
        },
      });

      expect(res.statusCode).not.toBe(409);
      // Distance AINEENAIIIII vs AINEENAOOOI4 → >2 (5 chars). Tier-2 misses.
    } finally {
      await app.close();
    }
  });
});
