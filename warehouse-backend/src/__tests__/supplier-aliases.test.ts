/**
 * Supplier alias learning — regression tests.
 *
 * These tests guard the "learn from user corrections" mechanism added in
 * migration 039. Scenarios covered:
 *
 *   1. Strategy-0 exact alias hit — an AI-extracted name that matches a
 *      previously-stored alias_normalized resolves to the alias's
 *      supplier_id WITHOUT running EIK/VAT/name/fuzzy branches.
 *
 *   2. Alias upsert on resolution — after any successful supplier match
 *      (alias / EIK / VAT / name / fuzzy / new-insert) we write a row into
 *      supplier_aliases tagged with the source that produced it.
 *
 *   3. user_confirmed authority guard — when the caller passes an
 *      explicit supplier_id (user_confirmed pick), the ON CONFLICT branch
 *      is told to FLIP the stored supplier_id. All other sources leave
 *      an existing mapping untouched.
 *
 * The production logic lives in warehouse-backend/src/routes/incoming.ts
 * around the `// ── 0. Learned alias` and `// ── Record alias` blocks.
 * Tests use a stateful mock of the DB client so we can assert on the
 * exact SQL / parameters shipped by the route without hitting Postgres.
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
      role: "admin",
    };
    (request as any).jwtVerify = async () => (request as any).user;
  });
  await app.register(incomingRoutes, { prefix: "/incoming" });
  return app;
}

type AliasRow = {
  alias_raw: string;
  alias_normalized: string;
  supplier_id: number;
  source: string;
  confidence: number;
  hit_count: number;
};

/**
 * Stateful mock of the transaction DB client. Seeds the tables used by
 * the incoming save flow and records every INSERT/UPDATE so tests can
 * assert ordering and params.
 */
function buildTxClient(opts: {
  seedAliases?: AliasRow[];
  supplierByEik?: Record<string, { id: number }>;
}) {
  const supplierAliases: AliasRow[] = [...(opts.seedAliases ?? [])];
  const upsertCalls: Array<{ sql: string; params: any[] }> = [];
  const aliasLookups: Array<{ rawName: string; hit: boolean }> = [];
  let nextIncomingId = 700;
  let nextItemId = 8000;

  const client = {
    supplierAliases,
    upsertCalls,
    aliasLookups,
    query: vi.fn(async (sql: string, params: any[] = []) => {
      // ── Strategy 0: alias exact lookup ────────────────────────────────
      if (
        sql.includes("FROM supplier_aliases") &&
        sql.includes("JOIN suppliers") &&
        sql.includes("alias_normalized = normalize_search($1)")
      ) {
        const rawName = params[0] as string;
        const fauxKey = normalizeSearchJs(rawName);
        const hit = supplierAliases.find((a) => a.alias_normalized === fauxKey);
        aliasLookups.push({ rawName, hit: !!hit });
        return resultRows(
          hit
            ? [{ id: hit.supplier_id, name: `Supplier #${hit.supplier_id}` }]
            : [],
        );
      }

      // ── Strategy 1: EIK match ─────────────────────────────────────────
      if (
        sql.includes("FROM suppliers") &&
        sql.includes("REGEXP_REPLACE(eik")
      ) {
        const eik = params[1] as string;
        const found = opts.supplierByEik?.[eik];
        return resultRows(found ? [{ id: found.id }] : []);
      }

      // ── Strategy 3: exact name ────────────────────────────────────────
      if (sql.includes("SELECT id FROM suppliers WHERE name ILIKE")) {
        return resultRows([]); // intentionally miss — we're isolating alias vs fuzzy
      }

      // ── Strategy 4: fuzzy ─────────────────────────────────────────────
      if (sql.includes("word_similarity") && sql.includes("FROM suppliers")) {
        return resultRows([]); // no fuzzy match in tests (alias covers it)
      }

      // ── EIK conflict check before auto-fill ───────────────────────────
      if (sql.includes("FROM suppliers") && sql.includes("id <> $1")) {
        return resultRows([]); // no conflict
      }

      // ── Auto-fill missing supplier fields ─────────────────────────────
      if (sql.includes("UPDATE suppliers SET")) {
        return resultRows([]);
      }

      // ── Create new supplier fallback ──────────────────────────────────
      if (sql.includes("INSERT INTO suppliers")) {
        return resultRows([{ id: 999 }]);
      }

      // ── Alias upsert (the core behaviour under test) ──────────────────
      if (sql.includes("INSERT INTO supplier_aliases")) {
        upsertCalls.push({ sql: String(sql), params });
        const [alias_raw, supplier_id, source, confidence, isAuthoritative] =
          params;
        const normalized = normalizeSearchJs(alias_raw);
        const existing = supplierAliases.find(
          (a) => a.alias_normalized === normalized,
        );
        if (existing) {
          existing.hit_count += 1;
          if (isAuthoritative) {
            existing.supplier_id = supplier_id;
            existing.source = "user_confirmed";
          }
          existing.confidence = Math.max(existing.confidence, confidence);
        } else {
          supplierAliases.push({
            alias_raw,
            alias_normalized: normalized,
            supplier_id,
            source,
            confidence,
            hit_count: 1,
          });
        }
        return resultRows([]);
      }

      // ── Product existence check (payload includes product_id) ────────
      if (sql.includes("SELECT id FROM products WHERE id = $1")) {
        return resultRows([{ id: params[0] }]);
      }

      // ── Incoming-goods scaffolding (we don't care about exact rows) ───
      if (sql.includes("INSERT INTO incoming_goods")) {
        nextIncomingId += 1;
        return resultRows([
          {
            id: nextIncomingId,
            supplier_id: null,
            invoice_number: params[1] ?? null,
            invoice_date: params[2] ?? null,
            status: "pending",
          },
        ]);
      }
      if (sql.includes("UPDATE incoming_goods")) {
        return resultRows([
          {
            id: params[params.length - 1] ?? 700,
            supplier_id: params[0] ?? null,
          },
        ]);
      }
      if (sql.includes("INSERT INTO incoming_items")) {
        nextItemId += 1;
        return resultRows([{ id: nextItemId }]);
      }

      // Catch-all: empty result is the safe default
      return resultRows([]);
    }),
  };

  return client;
}

// Rough JS approximation of SQL normalize_search() for mock matching.
// We only need enough fidelity to make alias keys collide the way the
// real function does in the fixtures we pass in.
function normalizeSearchJs(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-zа-я0-9 ]+/giu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

describe("supplier alias learning", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockTransaction.mockReset();
    mockQuery.mockResolvedValue(resultRows([]));
  });

  it("strategy 0: existing alias resolves without fuzzy match", async () => {
    const tx = buildTxClient({
      seedAliases: [
        {
          alias_raw: "DAGKOS Th. Athanasios",
          alias_normalized: normalizeSearchJs("DAGKOS Th. Athanasios"),
          supplier_id: 16,
          source: "user_confirmed",
          confidence: 1.0,
          hit_count: 3,
        },
      ],
    });
    mockTransaction.mockImplementation(async (fn: any) => fn(tx as any));

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/incoming",
        payload: {
          supplier_name: "DAGKOS Th. Athanasios",
          invoice_number: "GF-ALIAS-HIT-1",
          invoice_date: "2026-04-18",
          document_type: "invoice",
          visible_row_count: 1,
          extracted_row_count: 1,
          warnings: [],
          completeness_status: "complete",
          items: [
            {
              row_number: 1,
              page_number: 1,
              product_name_raw: "Dummy",
              product_name: "Dummy",
              product_id: 321,
              quantity: 1,
              unit_price: 1,
              unit: "бр",
            },
          ],
        },
      });

      expect(res.statusCode).toBe(201);

      // Strategy-0 fired exactly once and hit
      expect(tx.aliasLookups).toHaveLength(1);
      expect(tx.aliasLookups[0].hit).toBe(true);

      // hit_count incremented to 4 (no supplier flip, no source change)
      expect(tx.supplierAliases).toHaveLength(1);
      expect(tx.supplierAliases[0].hit_count).toBe(4);
      expect(tx.supplierAliases[0].supplier_id).toBe(16);
      expect(tx.supplierAliases[0].source).toBe("user_confirmed");
    } finally {
      await app.close();
    }
  });

  it("upsert records the source tag ('eik' / 'fuzzy' / 'user_confirmed')", async () => {
    // No seeded alias; resolve via EIK → expect an auto-upsert with source='eik'
    const tx = buildTxClient({
      supplierByEik: { EL997996067: { id: 21 } },
    });
    mockTransaction.mockImplementation(async (fn: any) => fn(tx as any));

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/incoming",
        payload: {
          supplier_name: "ELMAR CRETE S.A.",
          supplier_eik: "EL997996067",
          invoice_number: "GF-EIK-UPSERT-1",
          invoice_date: "2026-04-18",
          document_type: "invoice",
          visible_row_count: 1,
          extracted_row_count: 1,
          warnings: [],
          completeness_status: "complete",
          items: [
            {
              row_number: 1,
              page_number: 1,
              product_name_raw: "Dummy",
              product_name: "Dummy",
              product_id: 321,
              quantity: 1,
              unit_price: 1,
              unit: "бр",
            },
          ],
        },
      });
      expect(res.statusCode).toBe(201);

      // Upsert fired with source='eik' and isAuthoritative=false
      expect(tx.upsertCalls).toHaveLength(1);
      const params = tx.upsertCalls[0].params;
      expect(params[0]).toBe("ELMAR CRETE S.A."); // alias_raw
      expect(params[1]).toBe(21); // supplier_id
      expect(params[2]).toBe("eik"); // source
      expect(params[3]).toBe(1); // confidence (EIK = certain)
      expect(params[4]).toBe(false); // NOT authoritative → existing alias supplier_id is preserved
    } finally {
      await app.close();
    }
  });

  it("user_confirmed guard: authoritative pick overwrites prior auto-alias", async () => {
    // Seed an alias previously auto-linked to a WRONG supplier (from a
    // fuzzy false-positive). User corrects it on the review screen by
    // passing an explicit supplier_id → should flip + lock as user_confirmed.
    const tx = buildTxClient({
      seedAliases: [
        {
          alias_raw: "Ambiguous Brand Co.",
          alias_normalized: normalizeSearchJs("Ambiguous Brand Co."),
          supplier_id: 999, // wrong target from prior fuzzy match
          source: "fuzzy",
          confidence: 0.6,
          hit_count: 1,
        },
      ],
    });
    mockTransaction.mockImplementation(async (fn: any) => fn(tx as any));

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/incoming",
        payload: {
          supplier_id: 42, // user's explicit correction
          supplier_name: "Ambiguous Brand Co.",
          invoice_number: "GF-USER-FIX-1",
          invoice_date: "2026-04-18",
          document_type: "invoice",
          visible_row_count: 1,
          extracted_row_count: 1,
          warnings: [],
          completeness_status: "complete",
          items: [
            {
              row_number: 1,
              page_number: 1,
              product_name_raw: "Dummy",
              product_name: "Dummy",
              product_id: 321,
              quantity: 1,
              unit_price: 1,
              unit: "бр",
            },
          ],
        },
      });
      expect(res.statusCode).toBe(201);

      // The alias was flipped and locked as user_confirmed
      expect(tx.supplierAliases).toHaveLength(1);
      expect(tx.supplierAliases[0].supplier_id).toBe(42);
      expect(tx.supplierAliases[0].source).toBe("user_confirmed");
      expect(tx.supplierAliases[0].hit_count).toBe(2);
    } finally {
      await app.close();
    }
  });

  it("non-authoritative sources NEVER flip a user_confirmed mapping", async () => {
    // Seed a user_confirmed alias; subsequent scan tries an auto-source
    // (fuzzy) — the stored mapping must not change.
    const tx = buildTxClient({
      seedAliases: [
        {
          alias_raw: "SARYPOGLAS S.A.",
          alias_normalized: normalizeSearchJs("SARYPOGLAS S.A."),
          supplier_id: 57,
          source: "user_confirmed",
          confidence: 1.0,
          hit_count: 5,
        },
      ],
    });
    mockTransaction.mockImplementation(async (fn: any) => fn(tx as any));

    const app = await buildApp();
    try {
      await app.inject({
        method: "POST",
        url: "/incoming",
        payload: {
          // No explicit supplier_id → path resolves via strategy-0 alias.
          // Even if the route later had a fuzzy hit to a different
          // supplier, the user_confirmed mapping must win.
          supplier_name: "SARYPOGLAS S.A.",
          invoice_number: "GF-USER-LOCK-1",
          invoice_date: "2026-04-18",
          document_type: "invoice",
          visible_row_count: 1,
          extracted_row_count: 1,
          warnings: [],
          completeness_status: "complete",
          items: [
            {
              row_number: 1,
              page_number: 1,
              product_name_raw: "Dummy",
              product_name: "Dummy",
              product_id: 321,
              quantity: 1,
              unit_price: 1,
              unit: "бр",
            },
          ],
        },
      });

      expect(tx.supplierAliases[0].supplier_id).toBe(57); // unchanged
      expect(tx.supplierAliases[0].source).toBe("user_confirmed");
    } finally {
      await app.close();
    }
  });
});
