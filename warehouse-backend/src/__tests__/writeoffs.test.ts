import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import writeoffRoutes from "../routes/writeoffs.js";

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

type Role = "admin" | "warehouse" | "accountant" | "owner_mobile";

async function buildApp(role: Role = "warehouse") {
  const app = Fastify();

  app.addHook("onRequest", async (request) => {
    (request as any).user = {
      id: "00000000-0000-0000-0000-000000000001",
      email: `${role}@test.local`,
      role,
    };
    (request as any).jwtVerify = async () => (request as any).user;
  });

  await app.register(writeoffRoutes, { prefix: "/inventory/write-offs" });
  return app;
}

type BatchRecord = {
  id: number;
  product_id: number;
  quantity: number;
  purchase_price: number | null;
};

type InventoryRecord = {
  product_id: number;
  batch_id: number | null;
  warehouse_id: number;
  quantity: number;
};

type WriteoffRecord = {
  id: number;
  document_number: string;
  product_id: number;
  batch_id: number | null;
  warehouse_id: number;
  quantity: number;
  unit_cost: number;
  total_cost: number;
  reason: string;
  notes: string | null;
  written_off_by: string;
  written_off_at: string;
};

function buildStatefulTxClient(initial: {
  products: Array<{ id: number; purchase_price: number | null }>;
  batches: BatchRecord[];
  inventory: InventoryRecord[];
}) {
  const products = initial.products.slice();
  const batches = initial.batches.map((b) => ({ ...b }));
  const inventory = initial.inventory.map((inv) => ({ ...inv }));
  const writeoffs: WriteoffRecord[] = [];
  const auditEvents: Array<Record<string, unknown>> = [];
  const queries: Array<{ sql: string; params?: any[] }> = [];
  let nextWriteoffId = 500;
  let nextSeq = 1;

  const client = {
    products,
    batches,
    inventory,
    writeoffs,
    auditEvents,
    queries,
    query: vi.fn(async (sql: string, params?: any[]) => {
      queries.push({ sql: String(sql), params });

      if (sql.includes("FROM products WHERE id = $1")) {
        const product = products.find((p) => p.id === params?.[0]);
        return resultRows(product ? [product] : []);
      }

      if (sql.includes("FROM batches") && sql.includes("FOR UPDATE")) {
        const batch = batches.find((b) => b.id === params?.[0]);
        return resultRows(batch ? [batch] : []);
      }

      if (
        sql.includes("FROM inventory") &&
        sql.includes("batch_id IS NULL") &&
        sql.includes("FOR UPDATE")
      ) {
        const [productId, warehouseId] = params ?? [];
        const total = inventory
          .filter(
            (inv) =>
              inv.product_id === productId &&
              inv.batch_id == null &&
              inv.warehouse_id === warehouseId,
          )
          .reduce((sum, inv) => sum + inv.quantity, 0);
        return resultRows([{ total }]);
      }

      if (sql.includes("nextval('stock_writeoff_doc_seq')")) {
        const seq = nextSeq++;
        return resultRows([{ seq }]);
      }

      if (sql.includes("INSERT INTO stock_writeoffs")) {
        const [
          document_number,
          product_id,
          batch_id,
          warehouse_id,
          quantity,
          unit_cost,
          total_cost,
          reason,
          notes,
          written_off_by,
        ] = (params ?? []) as any[];
        const record: WriteoffRecord = {
          id: ++nextWriteoffId,
          document_number,
          product_id,
          batch_id: batch_id ?? null,
          warehouse_id,
          quantity: Number(quantity),
          unit_cost: Number(unit_cost),
          total_cost: Number(total_cost),
          reason,
          notes: notes ?? null,
          written_off_by,
          written_off_at: new Date().toISOString(),
        };
        writeoffs.push(record);
        return resultRows([record]);
      }

      if (sql.includes("UPDATE batches SET quantity")) {
        const [deltaQty, batchId] = params ?? [];
        const batch = batches.find((b) => b.id === batchId);
        if (batch) {
          batch.quantity -= Number(deltaQty);
        }
        return resultRows([]);
      }

      if (sql.includes("UPDATE inventory")) {
        const [deltaQty, productId, batchId, warehouseId] = params ?? [];
        const row = inventory.find(
          (inv) =>
            inv.product_id === productId &&
            ((inv.batch_id == null && batchId == null) ||
              inv.batch_id === batchId) &&
            inv.warehouse_id === warehouseId,
        );
        if (row) {
          row.quantity -= Number(deltaQty);
        }
        return resultRows([]);
      }

      if (sql.includes("INSERT INTO audit_events")) {
        auditEvents.push({
          actor_user_id: params?.[0],
          action: params?.[2],
          entity_type: params?.[3],
          entity_id: params?.[4],
          diff: params?.[5],
        });
        return resultRows([]);
      }

      return resultRows([]);
    }),
  };

  return client;
}

describe("POST /inventory/write-offs", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockTransaction.mockReset();
  });

  it("creates writeoff with unit_cost from batch, decrements batch + inventory", async () => {
    const txClient = buildStatefulTxClient({
      products: [{ id: 100, purchase_price: 1.5 }],
      batches: [
        { id: 200, product_id: 100, quantity: 10, purchase_price: 2.5 },
      ],
      inventory: [
        { product_id: 100, batch_id: 200, warehouse_id: 1, quantity: 10 },
      ],
    });
    mockTransaction.mockImplementation(async (fn: any) => fn(txClient as any));

    const app = await buildApp("warehouse");
    try {
      const res = await app.inject({
        method: "POST",
        url: "/inventory/write-offs",
        payload: {
          product_id: 100,
          batch_id: 200,
          quantity: 3,
          reason: "expired",
          notes: "spoilage check",
        },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.unit_cost).toBe(2.5);
      expect(body.total_cost).toBe(7.5);
      expect(body.product_id).toBe(100);
      expect(body.batch_id).toBe(200);

      // Batch + inventory both decremented atomically
      expect(txClient.batches[0].quantity).toBe(7);
      expect(txClient.inventory[0].quantity).toBe(7);

      // Audit event recorded
      expect(txClient.auditEvents).toHaveLength(1);
      expect(txClient.auditEvents[0].action).toBe("stock_writeoff.create");
    } finally {
      await app.close();
    }
  });

  it("generates document_number in БРАК-YYYY-NNNN format", async () => {
    const txClient = buildStatefulTxClient({
      products: [{ id: 100, purchase_price: 1 }],
      batches: [{ id: 201, product_id: 100, quantity: 5, purchase_price: 1 }],
      inventory: [
        { product_id: 100, batch_id: 201, warehouse_id: 1, quantity: 5 },
      ],
    });
    mockTransaction.mockImplementation(async (fn: any) => fn(txClient as any));

    const app = await buildApp("warehouse");
    try {
      const res = await app.inject({
        method: "POST",
        url: "/inventory/write-offs",
        payload: {
          product_id: 100,
          batch_id: 201,
          quantity: 1,
          reason: "damaged",
        },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      const year = new Date().getUTCFullYear();
      expect(body.document_number).toMatch(new RegExp(`^БРАК-${year}-\\d{4}$`));
      expect(body.document_number).toBe(`БРАК-${year}-0001`);
    } finally {
      await app.close();
    }
  });

  it("rejects quantity > available (400)", async () => {
    const txClient = buildStatefulTxClient({
      products: [{ id: 100, purchase_price: 1 }],
      batches: [{ id: 202, product_id: 100, quantity: 2, purchase_price: 1 }],
      inventory: [
        { product_id: 100, batch_id: 202, warehouse_id: 1, quantity: 2 },
      ],
    });
    mockTransaction.mockImplementation(async (fn: any) => fn(txClient as any));

    const app = await buildApp("warehouse");
    try {
      const res = await app.inject({
        method: "POST",
        url: "/inventory/write-offs",
        payload: {
          product_id: 100,
          batch_id: 202,
          quantity: 5,
          reason: "damaged",
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/Недостатъчно/);
      // Nothing mutated
      expect(txClient.batches[0].quantity).toBe(2);
      expect(txClient.writeoffs).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("rejects batch_id that doesn't belong to product (400)", async () => {
    const txClient = buildStatefulTxClient({
      products: [{ id: 100, purchase_price: 1 }],
      batches: [{ id: 203, product_id: 999, quantity: 10, purchase_price: 1 }],
      inventory: [],
    });
    mockTransaction.mockImplementation(async (fn: any) => fn(txClient as any));

    const app = await buildApp("warehouse");
    try {
      const res = await app.inject({
        method: "POST",
        url: "/inventory/write-offs",
        payload: {
          product_id: 100,
          batch_id: 203,
          quantity: 1,
          reason: "damaged",
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/не съответства/);
    } finally {
      await app.close();
    }
  });

  it("returns 403 for accountant role on POST", async () => {
    const app = await buildApp("accountant");
    try {
      const res = await app.inject({
        method: "POST",
        url: "/inventory/write-offs",
        payload: {
          product_id: 100,
          batch_id: 200,
          quantity: 1,
          reason: "damaged",
        },
      });
      expect(res.statusCode).toBe(403);
      expect(mockTransaction).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("returns 201 for warehouse role on POST", async () => {
    const txClient = buildStatefulTxClient({
      products: [{ id: 100, purchase_price: 3 }],
      batches: [{ id: 204, product_id: 100, quantity: 10, purchase_price: 3 }],
      inventory: [
        { product_id: 100, batch_id: 204, warehouse_id: 1, quantity: 10 },
      ],
    });
    mockTransaction.mockImplementation(async (fn: any) => fn(txClient as any));

    const app = await buildApp("warehouse");
    try {
      const res = await app.inject({
        method: "POST",
        url: "/inventory/write-offs",
        payload: {
          product_id: 100,
          batch_id: 204,
          quantity: 2,
          reason: "theft",
        },
      });
      expect(res.statusCode).toBe(201);
    } finally {
      await app.close();
    }
  });

  it("falls back to products.purchase_price when batch_id is null", async () => {
    const txClient = buildStatefulTxClient({
      products: [{ id: 100, purchase_price: 4.25 }],
      batches: [],
      inventory: [
        { product_id: 100, batch_id: null, warehouse_id: 1, quantity: 8 },
      ],
    });
    mockTransaction.mockImplementation(async (fn: any) => fn(txClient as any));

    const app = await buildApp("warehouse");
    try {
      const res = await app.inject({
        method: "POST",
        url: "/inventory/write-offs",
        payload: {
          product_id: 100,
          batch_id: null,
          quantity: 2,
          reason: "count_correction",
        },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.unit_cost).toBe(4.25);
      expect(body.total_cost).toBe(8.5);
      expect(body.batch_id).toBeNull();
      expect(txClient.inventory[0].quantity).toBe(6);
    } finally {
      await app.close();
    }
  });
});

describe("GET /inventory/write-offs", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockTransaction.mockReset();
  });

  it("returns paginated list with filters applied", async () => {
    mockQuery
      .mockResolvedValueOnce(
        resultRows([
          {
            id: 1,
            document_number: "БРАК-2026-0001",
            product_id: 100,
            batch_id: 200,
            quantity: "3.000",
            unit_cost: "2.50",
            total_cost: "7.50",
            reason: "expired",
            product_name_bg: "Баклавички",
            product_name_en: "Baklava",
            product_sku: "SKU-1",
            batch_number: "B-001",
            written_off_by_email: "w@test.local",
          },
        ]),
      )
      .mockResolvedValueOnce(resultRows([{ total: 1 }]));

    const app = await buildApp("warehouse");
    try {
      const res = await app.inject({
        method: "GET",
        url: "/inventory/write-offs?reason=expired&product_id=100&page=1&limit=20",
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].document_number).toBe("БРАК-2026-0001");
      expect(body.pagination).toEqual({ page: 1, limit: 20, total: 1 });

      // Verify filter params were bound
      const firstCall = mockQuery.mock.calls[0];
      const listSql = String(firstCall[0]);
      const listParams = firstCall[1] as unknown[];
      expect(listSql).toContain("w.reason = $");
      expect(listSql).toContain("w.product_id = $");
      expect(listParams).toContain("expired");
      expect(listParams).toContain(100);
    } finally {
      await app.close();
    }
  });
});
