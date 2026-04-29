import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";

const capturedQueries: Array<{ sql: string; params: unknown[] }> = [];

vi.mock("../db.js", () => ({
  query: vi.fn(async (sql: string, params: unknown[] = []) => {
    capturedQueries.push({ sql, params });
    if (sql.includes("FROM products")) {
      return {
        rows: [
          {
            id: 1,
            name_bg: "Фритюрник",
            name_en: "Fryer",
            name: "Фритюрник",
            sku: "HD-42",
            brand: "Hendi",
            microinvest_code: "MI-001",
            unit: "бр",
            selling_price: "1250.00",
            stock_level: "3",
          },
        ],
      };
    }
    return { rows: [] };
  }),
  transaction: vi.fn(),
}));

import chatRoutes from "../routes/chat.js";

async function buildAuthedApp() {
  const app = Fastify();
  app.addHook("onRequest", async (request) => {
    (request as any).user = { id: "u-1", email: "a@b.c", role: "admin" };
    (request as any).jwtVerify = async () => (request as any).user;
  });
  await app.register(chatRoutes);
  return app;
}

async function buildUnauthedApp() {
  const app = Fastify();
  app.addHook("onRequest", async (request) => {
    (request as any).jwtVerify = async () => {
      throw new Error("no token");
    };
  });
  await app.register(chatRoutes);
  return app;
}

describe("/chat", () => {
  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = "test-key";
    capturedQueries.length = 0;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.CHAT_PROVIDER;
    delete process.env.CHAT_MODEL;
    delete process.env.OLLAMA_BASE_URL;
    delete process.env.OLLAMA_THINK;
    delete process.env.OLLAMA_FORMAT;
    delete process.env.OLLAMA_KEEP_ALIVE;
    delete process.env.OLLAMA_NUM_CTX;
    delete process.env.OLLAMA_TEMPERATURE;
  });

  it("returns 401 without auth", async () => {
    const app = await buildUnauthedApp();
    const res = await app.inject({
      method: "POST",
      url: "/chat",
      payload: { message: "hi" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns LLM reply when no tool calls requested", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              { message: { role: "assistant", content: "Здравейте!" } },
            ],
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const app = await buildAuthedApp();
    const res = await app.inject({
      method: "POST",
      url: "/chat",
      payload: { message: "Здравей", history: [] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ reply: "Здравейте!" });
  });

  it("dispatches search_products tool", async () => {
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call++;
      if (call === 1) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "tc1",
                      function: {
                        name: "search_products",
                        arguments: '{"query":"фрит"}',
                      },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: "Намерих 1 продукт: Фритюрник (HD-42)",
              },
            },
          ],
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const app = await buildAuthedApp();
    const res = await app.inject({
      method: "POST",
      url: "/chat",
      payload: { message: "търси фритюрници" },
    });
    expect(res.statusCode).toBe(200);
    const data = res.json();
    expect(data.reply).toContain("Фритюрник");
    expect(data.tool_calls).toHaveLength(1);
    expect(data.tool_calls[0].name).toBe("search_products");

    // MERT-M products table has no deleted_at column — the search SQL must
    // not reference it, and must search every expected field with a single
    // parameterized %query% placeholder.
    const productSearch = capturedQueries.find((q) =>
      q.sql.includes("FROM products"),
    );
    expect(productSearch).toBeDefined();
    const sql = productSearch!.sql;
    expect(sql).not.toMatch(/deleted_at/i);
    expect(sql).toMatch(/p\.name_bg\s+ILIKE\s+\$1/);
    expect(sql).toMatch(/p\.name_en\s+ILIKE\s+\$1/);
    expect(sql).toMatch(/p\.sku\s+ILIKE\s+\$1/);
    expect(sql).toMatch(/p\.brand\s+ILIKE\s+\$1/);
    expect(sql).toMatch(/p\.microinvest_code\s+ILIKE\s+\$1/);
    expect(productSearch!.params).toEqual(["%фрит%"]);
  });

  it("returns 500 when OPENROUTER_API_KEY missing", async () => {
    delete process.env.OPENROUTER_API_KEY;
    const app = await buildAuthedApp();
    const res = await app.inject({
      method: "POST",
      url: "/chat",
      payload: { message: "hi" },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ error: "no_llm_key" });
  });

  it("ollama provider does not require OPENROUTER_API_KEY", async () => {
    delete process.env.OPENROUTER_API_KEY;
    process.env.CHAT_PROVIDER = "ollama";
    process.env.CHAT_MODEL = "qwen3:8b";
    process.env.OLLAMA_BASE_URL = "http://127.0.0.1:11434";
    process.env.OLLAMA_FORMAT = "json";

    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          message: {
            role: "assistant",
            content:
              '{"action":"none","confidence":0.9,"requires_confirmation":false}',
          },
          done: true,
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const app = await buildAuthedApp();
    const res = await app.inject({
      method: "POST",
      url: "/chat",
      payload: { message: "Здравей" },
    });
    expect(res.statusCode).toBe(200);
    const data = res.json();
    expect(data.tool_calls).toEqual([]);
    expect(typeof data.reply).toBe("string");
  });

  it("ollama JSON action generate_invoice executes generate_invoice tool", async () => {
    delete process.env.OPENROUTER_API_KEY;
    process.env.CHAT_PROVIDER = "ollama";
    process.env.CHAT_MODEL = "qwen3:8b";
    process.env.OLLAMA_BASE_URL = "http://127.0.0.1:11434";
    process.env.OLLAMA_FORMAT = "json";

    const fetchMock = vi.fn(async (input: unknown) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      if (url.includes("/invoices")) {
        return new Response(
          JSON.stringify({ id: 99, invoice_number: "INV-001" }),
          { status: 200 },
        );
      }
      // Ollama /api/chat
      return new Response(
        JSON.stringify({
          message: {
            role: "assistant",
            content:
              '{"action":"generate_invoice","order_id":42,"confidence":0.95,"requires_confirmation":false}',
          },
          done: true,
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const app = await buildAuthedApp();
    const res = await app.inject({
      method: "POST",
      url: "/chat",
      payload: { message: "издай фактура за поръчка 42" },
    });
    expect(res.statusCode).toBe(200);
    const data = res.json();
    expect(data.tool_calls).toHaveLength(1);
    expect(data.tool_calls[0].name).toBe("generate_invoice");
    expect(data.tool_calls[0].args).toMatchObject({ order_id: 42 });
    expect(data.tool_calls[0].result).toMatchObject({
      invoice: { id: 99, invoice_number: "INV-001" },
    });
  });

  it("invalid/unknown ollama action does not execute tool", async () => {
    delete process.env.OPENROUTER_API_KEY;
    process.env.CHAT_PROVIDER = "ollama";
    process.env.CHAT_MODEL = "qwen3:8b";
    process.env.OLLAMA_BASE_URL = "http://127.0.0.1:11434";
    process.env.OLLAMA_FORMAT = "json";

    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          message: {
            role: "assistant",
            content:
              '{"action":"hack_database","confidence":0.99,"requires_confirmation":false}',
          },
          done: true,
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const app = await buildAuthedApp();
    const res = await app.inject({
      method: "POST",
      url: "/chat",
      payload: { message: "счупи нещо" },
    });
    expect(res.statusCode).toBe(200);
    const data = res.json();
    expect(data.tool_calls).toEqual([]);
    // Only the Ollama call should have been made — no /invoices, /econt etc.
    for (const call of fetchMock.mock.calls as unknown[][]) {
      const arg = call[0];
      const url =
        typeof arg === "string"
          ? arg
          : arg instanceof URL
            ? arg.toString()
            : (arg as Request).url;
      expect(url).toContain("/api/chat");
    }
    expect(typeof data.reply).toBe("string");
    expect(data.reply.length).toBeGreaterThan(0);
  });

  it("ollama JSON action get_order maps order_id alias to id", async () => {
    delete process.env.OPENROUTER_API_KEY;
    process.env.CHAT_PROVIDER = "ollama";

    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          message: {
            role: "assistant",
            content:
              '{"action":"get_order","order_id":42,"confidence":0.95,"requires_confirmation":false}',
          },
          done: true,
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const app = await buildAuthedApp();
    const res = await app.inject({
      method: "POST",
      url: "/chat",
      payload: { message: "покажи поръчка 42" },
    });
    expect(res.statusCode).toBe(200);
    const data = res.json();
    expect(data.tool_calls).toHaveLength(1);
    expect(data.tool_calls[0].name).toBe("get_order");
    expect(data.tool_calls[0].args).toEqual({ id: 42 });
  });

  it("ollama JSON action track_shipment maps tracking_number alias to shipment_number", async () => {
    delete process.env.OPENROUTER_API_KEY;
    process.env.CHAT_PROVIDER = "ollama";

    const fetchMock = vi.fn(async (input: unknown) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      if (url.includes("/econt/track/")) {
        return new Response(JSON.stringify({ status: "in_transit" }), {
          status: 200,
        });
      }
      return new Response(
        JSON.stringify({
          message: {
            role: "assistant",
            content:
              '{"action":"track_shipment","tracking_number":"123","confidence":0.95,"requires_confirmation":false}',
          },
          done: true,
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const app = await buildAuthedApp();
    const res = await app.inject({
      method: "POST",
      url: "/chat",
      payload: { message: "проследи 123" },
    });
    expect(res.statusCode).toBe(200);
    const data = res.json();
    expect(data.tool_calls).toHaveLength(1);
    expect(data.tool_calls[0].name).toBe("track_shipment");
    expect(data.tool_calls[0].args).toEqual({ shipment_number: "123" });
  });

  it("ollama JSON action with requires_confirmation=true does not execute tool", async () => {
    delete process.env.OPENROUTER_API_KEY;
    process.env.CHAT_PROVIDER = "ollama";

    const fetchMock = vi.fn(async (input: unknown) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      // Fail loudly if backend tries to hit /invoices despite confirmation gate.
      if (url.includes("/invoices")) {
        throw new Error(
          "should not call /invoices when requires_confirmation=true",
        );
      }
      return new Response(
        JSON.stringify({
          message: {
            role: "assistant",
            content:
              '{"action":"generate_invoice","order_id":42,"confidence":0.95,"requires_confirmation":true}',
          },
          done: true,
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const app = await buildAuthedApp();
    const res = await app.inject({
      method: "POST",
      url: "/chat",
      payload: { message: "издай фактура за поръчка 42" },
    });
    expect(res.statusCode).toBe(200);
    const data = res.json();
    expect(data.tool_calls).toEqual([]);
    // Only the Ollama call should have been issued — no invoice call.
    for (const call of fetchMock.mock.calls as unknown[][]) {
      const arg = call[0];
      const url =
        typeof arg === "string"
          ? arg
          : arg instanceof URL
            ? arg.toString()
            : (arg as Request).url;
      expect(url).not.toContain("/invoices");
    }
    // Reply must be a Bulgarian confirmation prompt.
    expect(typeof data.reply).toBe("string");
    expect(data.reply.length).toBeGreaterThan(0);
    expect(data.reply).toMatch(/потвърд/i);
  });
});
