// Смяна на ДДС режима на издадена фактура при регенериране (същият номер).
//
// Повод: фактура 0000000338 на Bulstock Ltd (износ, GB ДДС номер) излезе
// С ДДС по грешка — 2 816,81 нето + 563,36 ДДС = 3 380,17. Трябва да се
// преиздаде без ДДС с основание чл. 28. Досега сървърът отказваше смяна
// на ДДС за всичко освен проформа.
import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({
  query: vi.fn(),
  transaction: vi.fn(),
}));
vi.mock("../lib/redis.js", () => ({
  getRedis: vi.fn(async () => ({
    get: vi.fn(async () => null),
    setex: vi.fn(async () => "OK"),
    del: vi.fn(async () => 0),
  })),
}));
vi.mock("../services/invoice-pdf.js", () => ({
  generateInvoicePdf: vi.fn(async () => undefined),
}));

import { query, transaction } from "../db.js";
import { generateInvoicePdf } from "../services/invoice-pdf.js";
import invoicesRoutes from "../routes/invoices.js";

const mockQuery = vi.mocked(query);
const mockTx = vi.mocked(transaction);
const mockPdf = vi.mocked(generateInvoicePdf);

function rows<T>(list: T[]) {
  return { rows: list, rowCount: list.length } as any;
}

const EXPORT_BASIS = "Износ — нулева ставка по чл. 28 ЗДДС";

const bulstockInvoice = {
  id: 370,
  invoice_number: "0000000338",
  invoice_date: "2026-10-14",
  document_type: "invoice",
  status: "active",
  include_vat: true,
  vat_exemption_reason: null,
  partner_id: 432,
  payment_method: "cash",
  unit_price_rule: "entered",
};

const bulstockItems = [
  {
    id: 9001,
    order_id: 355,
    name_bg: "Торта Ферерино",
    sku: "IM210715",
    unit: "бр.",
    quantity: "1.000",
    unit_price: "2816.810",
    discount_percent: "0.00",
    total_price: "2816.81",
    line_status: "normal",
  },
];

/** Транзакцията с SQL-маршрути; връща записаните заявки. */
function world(opts: {
  invoice: Record<string, unknown>;
  creditNotes?: Array<{ invoice_number: string }>;
  paid?: string;
}) {
  const calls: Array<{ sql: string; params: any[] }> = [];
  const clientQuery = vi.fn(async (sql: string, params: any[] = []) => {
    calls.push({ sql, params });
    if (/SELECT \* FROM invoices WHERE id = \$1/.test(sql)) {
      return rows([opts.invoice]);
    }
    if (/FROM invoices\s+WHERE related_invoice_id/.test(sql)) {
      return rows(opts.creditNotes ?? []);
    }
    if (/FROM orders WHERE (proforma_)?invoice_id = \$1/.test(sql)) {
      return rows([
        { id: 355, order_number: 351, partner_id: 432, invoice_id: 370 },
      ]);
    }
    if (/FROM order_items oi/.test(sql)) return rows(bulstockItems);
    if (/FROM partners WHERE id = \$1/.test(sql)) {
      return rows([
        {
          id: 432,
          name: "Bulstock Ltd",
          vat_number: "GB173463305",
          partner_type: "customer",
        },
      ]);
    }
    if (/SUM\(amount\).*FROM payments/i.test(sql)) {
      return rows([{ total: opts.paid ?? "0" }]);
    }
    if (/^UPDATE invoices\s+SET total_net/.test(sql)) {
      return rows([
        {
          ...opts.invoice,
          total_net: params[0],
          total_vat: params[1],
          total_gross: params[2],
          include_vat: params[3],
          vat_exemption_reason: params[5] ?? opts.invoice.vat_exemption_reason,
        },
      ]);
    }
    return rows([]);
  });
  mockTx.mockImplementation(async (cb: any) => cb({ query: clientQuery }));
  return { calls };
}

async function regenerate(payload: Record<string, unknown>) {
  const app = Fastify();
  app.addHook("onRequest", async (req) => {
    (req as any).user = { id: "u-admin", email: "admin@test", role: "admin" };
    (req as any).jwtVerify = async () => (req as any).user;
  });
  await app.register(invoicesRoutes, { prefix: "/invoices" });
  try {
    return await app.inject({
      method: "PUT",
      url: "/invoices/370/regenerate",
      payload,
    });
  } finally {
    await app.close();
  }
}

// Тестовото приложение е без error handler-а от index.ts: текстът е в
// `message` (в продукцията — в `error`).
const errorText = (res: any) => {
  const body = res.json();
  return String(body.message ?? body.error ?? "");
};

const updateCall = (calls: Array<{ sql: string; params: any[] }>) =>
  calls.find((c) => /^UPDATE invoices\s+SET total_net/.test(c.sql));
const notification = (calls: Array<{ sql: string; params: any[] }>) =>
  calls.find((c) => /INSERT INTO notifications/.test(c.sql));

describe("PUT /invoices/:id/regenerate — смяна на ДДС на издадена фактура", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockTx.mockReset();
    mockPdf.mockClear();
    mockQuery.mockResolvedValue(rows([{ company_name: "GQF" }]));
  });

  it("Bulstock 0000000338: с ДДС → без ДДС, същият номер, основанието влиза", async () => {
    const { calls } = world({ invoice: bulstockInvoice });
    const res = await regenerate({
      include_vat: false,
      vat_exemption_reason: EXPORT_BASIS,
    });
    expect(res.statusCode).toBe(200);
    const update = updateCall(calls)!;
    // [нето, ДДС, общо, include_vat, плащане, основание, бележка, id]
    expect(update.params.slice(0, 4)).toEqual([2816.81, 0, 2816.81, false]);
    expect(update.params[5]).toBe(EXPORT_BASIS);
    const pdf = mockPdf.mock.calls[0][0] as any;
    expect(pdf.includeVat).toBe(false);
    expect(pdf.vatRate).toBe(0);
    expect(pdf.invoice.invoice_number).toBe("0000000338");
    expect(pdf.outputPath).toMatch(/0000000338\.pdf$/);
    const note = notification(calls)!;
    expect(note.params[0]).toContain("0000000338");
    expect(note.params[0]).toContain("БЕЗ ДДС");
    expect(note.params[0]).toContain("2816,81");
    expect(note.params[0]).toContain("чл. 28");
  });

  it("без ДДС без основание → 400, нищо не се записва", async () => {
    const { calls } = world({ invoice: bulstockInvoice });
    const res = await regenerate({ include_vat: false });
    expect(res.statusCode).toBe(400);
    expect(errorText(res)).toContain("основание");
    expect(updateCall(calls)).toBeUndefined();
    expect(mockPdf).not.toHaveBeenCalled();
  });

  it("има кредитно известие → 409 с номера му", async () => {
    const { calls } = world({
      invoice: bulstockInvoice,
      creditNotes: [{ invoice_number: "КИ-0000000005" }],
    });
    const res = await regenerate({
      include_vat: false,
      vat_exemption_reason: EXPORT_BASIS,
    });
    expect(res.statusCode).toBe(409);
    expect(errorText(res)).toContain("КИ-0000000005");
    expect(updateCall(calls)).toBeUndefined();
  });

  it("платено повече от новата сума → 409 с двете суми", async () => {
    const { calls } = world({ invoice: bulstockInvoice, paid: "3380.17" });
    const res = await regenerate({
      include_vat: false,
      vat_exemption_reason: EXPORT_BASIS,
    });
    expect(res.statusCode).toBe(409);
    expect(errorText(res)).toContain("3380,17");
    expect(errorText(res)).toContain("2816,81");
    expect(updateCall(calls)).toBeUndefined();
  });

  it("без ДДС → с ДДС: 20% отгоре и известие", async () => {
    const { calls } = world({
      invoice: {
        ...bulstockInvoice,
        include_vat: false,
        vat_exemption_reason: EXPORT_BASIS,
      },
    });
    const res = await regenerate({ include_vat: true });
    expect(res.statusCode).toBe(200);
    expect(updateCall(calls)!.params.slice(0, 4)).toEqual([
      2816.81,
      563.36,
      3380.17,
      true,
    ]);
    expect(notification(calls)!.params[0]).toContain("С ДДС");
  });

  it("без смяна на режима — без проверка за КИ и без известие (както досега)", async () => {
    const { calls } = world({ invoice: bulstockInvoice });
    const res = await regenerate({});
    expect(res.statusCode).toBe(200);
    expect(calls.some((c) => /related_invoice_id/.test(c.sql))).toBe(false);
    expect(notification(calls)).toBeUndefined();
    expect(updateCall(calls)!.params.slice(0, 4)).toEqual([
      2816.81,
      563.36,
      3380.17,
      true,
    ]);
  });

  it("проформа: смяна без основание е позволена (както досега)", async () => {
    const { calls } = world({
      invoice: {
        ...bulstockInvoice,
        document_type: "proforma",
        invoice_number: "PR.INV0000000010",
      },
    });
    const res = await regenerate({ include_vat: false });
    expect(res.statusCode).toBe(200);
    expect(updateCall(calls)!.params[3]).toBe(false);
    expect(notification(calls)).toBeUndefined();
  });
});
