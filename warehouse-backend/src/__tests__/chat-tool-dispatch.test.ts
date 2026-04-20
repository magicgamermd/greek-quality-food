import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";

vi.mock("../db.js", () => ({
  query: vi.fn(async (sql: string) => {
    if (sql.includes("FROM products")) {
      return { rows: [{ id: 1, name: "Фритюрник", sku: "HD-42" }] };
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
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.OPENROUTER_API_KEY;
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
});
